import BaseAdapter, { StorageProxy } from "./base";
import {
  filterObject,
  omitKeys,
  sortObjects,
  arrayEqual,
  transformSubObjectFilters,
} from "../utils";
import { RecordStatus } from "../types";
import { KintoObject } from "../http";

const INDEXED_FIELDS = ["id", "_status", "last_modified"];

/**
 * Small helper that wraps the opening of an IndexedDB into a Promise.
 *
 * @param dbname          {String}   The database name.
 * @param version         {Integer}  Schema version
 * @param onupgradeneeded {Function} The callback to execute if schema is
 *                                   missing or different.
 * @return {Promise<IDBDatabase>}
 */
export async function open(
  dbname: string,
  {
    version,
    onupgradeneeded,
  }: {
    version?: number;
    onupgradeneeded: (event: IDBVersionChangeEvent) => void;
  }
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbname, version);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      db.onerror = (event) => reject(request.error);
      // When an upgrade is needed, a transaction is started.
      const transaction = request.transaction!;
      transaction.onabort = (event) => {
        const error =
          request.error ||
          transaction.error ||
          new DOMException("The operation has been aborted", "AbortError");
        reject(error);
      };
      // Callback for store creation etc.
      return onupgradeneeded(event);
    };
    request.onerror = (event) => {
      reject((event.target as IDBRequest).error);
    };
    request.onsuccess = (event) => {
      const db = request.result;
      resolve(db);
    };
  });
}

/**
 * Helper to run the specified callback in a single transaction on the
 * specified store.
 * The helper focuses on transaction wrapping into a promise.
 *
 * @param db           {IDBDatabase} The database instance.
 * @param name         {String}      The store name.
 * @param callback     {Function}    The piece of code to execute in the transaction.
 * @param options      {Object}      Options.
 * @param options.mode {String}      Transaction mode (default: read).
 * @return {Promise} any value returned by the callback.
 */
export async function execute(
  db: IDBDatabase,
  name: string,
  callback: (store: IDBObjectStore, abort?: (...args: any[]) => any) => any,
  options: { mode?: IDBTransactionMode } = {}
): Promise<unknown> {
  const { mode } = options;
  return new Promise((resolve, reject) => {
    // On Safari, calling IDBDatabase.transaction with mode == undefined raises
    // a TypeError.
    const transaction = mode
      ? db.transaction([name], mode)
      : db.transaction([name]);
    const store = transaction.objectStore(name);

    // Let the callback abort this transaction.
    const abort = (e: any) => {
      transaction.abort();
      console.error(e);
      reject(e);
    };
    // Execute the specified callback **synchronously**.
    let result: unknown;
    try {
      result = callback(store, abort);
    } catch (e) {
      abort(e);
    }
    transaction.onerror = (event) =>
      reject((event.target as IDBTransaction).error);
    transaction.oncomplete = (event) => resolve(result);
    transaction.onabort = (event) => {
      const error =
        (event.target as IDBTransaction).error ||
        transaction.error ||
        new DOMException("The operation has been aborted", "AbortError");
      reject(error);
    };
  });
}

/**
 * Helper to wrap the deletion of an IndexedDB database into a promise.
 *
 * @param dbName {String} the database to delete
 * @return {Promise}
 */
async function deleteDatabase(dbName: string): Promise<IDBOpenDBRequest> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(dbName);
    request.onsuccess = (event) => resolve(event.target as IDBOpenDBRequest);
    request.onerror = (event) =>
      reject((event.target as IDBOpenDBRequest).error);
  });
}

/**
 * IDB cursor handlers.
 * @type {Object}
 */
const cursorHandlers = {
  all(
    filters: {
      [key: string]: any;
    },
    done: (records: KintoObject[]) => void
  ) {
    const results: KintoObject[] = [];
    return (event: Event) => {
      const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
      if (cursor) {
        const { value } = cursor;
        if (filterObject(filters, value)) {
          results.push(value);
        }
        cursor.continue();
      } else {
        done(results);
      }
    };
  },

  in(
    values: any[],
    filters: {
      [key: string]: any;
    },
    done: (records: KintoObject[]) => void
  ) {
    const results: KintoObject[] = [];
    let i = 0;
    return function (event: Event) {
      const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
      if (!cursor) {
        done(results);
        return;
      }
      const { key, value } = cursor;
      // `key` can be an array of two values (see `keyPath` in indices definitions).
      // `values` can be an array of arrays if we filter using an index whose key path
      // is an array (eg. `cursorHandlers.in([["bid/cid", 42], ["bid/cid", 43]], ...)`)
      while (key > values[i]) {
        // The cursor has passed beyond this key. Check next.
        ++i;
        if (i === values.length) {
          done(results); // There is no next. Stop searching.
          return;
        }
      }
      const isEqual = Array.isArray(key)
        ? arrayEqual(key, values[i])
        : key === values[i];
      if (isEqual) {
        if (filterObject(filters, value)) {
          results.push(value);
        }
        cursor.continue();
      } else {
        cursor.continue(values[i]);
      }
    };
  },
};

/**
 * Creates an IDB request and attach it the appropriate cursor event handler to
 * perform a list query.
 *
 * Multiple matching values are handled by passing an array.
 *
 * @param  {String}           cid        The collection id (ie. `{bid}/{cid}`)
 * @param  {IDBStore}         store      The IDB store.
 * @param  {Object}           filters    Filter the records by field.
 * @param  {Function}         done       The operation completion handler.
 * @return {IDBRequest}
 */
function createListRequest(
  cid: string,
  store: IDBObjectStore,
  filters: {
    [key: string]: any;
  },
  done: (records: KintoObject[]) => void
) {
  const filterFields = Object.keys(filters);

  // If no filters, get all results in one bulk.
  if (filterFields.length === 0) {
    const request = store.index("cid").getAll(IDBKeyRange.only(cid));
    request.onsuccess = (event) => done((event.target as IDBRequest).result);
    return request;
  }

  // Introspect filters and check if they leverage an indexed field.
  const indexField = filterFields.find((field) => {
    return INDEXED_FIELDS.includes(field);
  });

  if (!indexField) {
    // Iterate on all records for this collection (ie. cid)
    const isSubQuery = Object.keys(filters).some((key) => key.includes(".")); // (ie. filters: {"article.title": "hello"})
    if (isSubQuery) {
      const newFilter = transformSubObjectFilters(filters);
      const request = store.index("cid").openCursor(IDBKeyRange.only(cid));
      request.onsuccess = cursorHandlers.all(newFilter, done);
      return request;
    }

    const request = store.index("cid").openCursor(IDBKeyRange.only(cid));
    request.onsuccess = cursorHandlers.all(filters, done);
    return request;
  }
  // If `indexField` was used already, don't filter again.
  const remainingFilters = omitKeys(filters, [indexField]);

  // value specified in the filter (eg. `filters: { _status: ["created", "updated"] }`)
  const value = filters[indexField];
  // For the "id" field, use the primary key.
  const indexStore = indexField === "id" ? store : store.index(indexField);

  // WHERE IN equivalent clause
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return done([]);
    }
    const values = value.map((i) => [cid, i]).sort();
    const range = IDBKeyRange.bound(values[0], values[values.length - 1]);
    const request = indexStore.openCursor(range);
    request.onsuccess = cursorHandlers.in(values, remainingFilters, done);
    return request;
  }

  // If no filters on custom attribute, get all results in one bulk.
  if (Object.keys(remainingFilters).length === 0) {
    const request = indexStore.getAll(IDBKeyRange.only([cid, value]));
    request.onsuccess = (event: Event) =>
      done((event.target as IDBRequest).result);
    return request;
  }

  // WHERE field = value clause
  const request = indexStore.openCursor(IDBKeyRange.only([cid, value]));
  request.onsuccess = cursorHandlers.all(remainingFilters, done);
  return request;
}

class IDBError extends Error {
  constructor(method: string, err: Error) {
    super(`IndexedDB ${method}() ${err.message}`);
    this.name = err.name;
    this.stack = err.stack;
  }
}

/**
 * IndexedDB adapter.
 *
 * This adapter doesn't support any options.
 */
export default class IDB<
  B extends { id: string; last_modified?: number; _status?: RecordStatus }
> extends BaseAdapter<B> {
  private _db: IDBDatabase | null;
  public cid: string;
  public dbName: string;
  private _options: { dbName?: string; migrateOldData?: boolean };

  /* Expose the IDBError class publicly */
  static get IDBError() {
    return IDBError;
  }

  /**
   * Constructor.
   *
   * @param  {String} cid  The key base for this collection (eg. `bid/cid`)
   * @param  {Object} options
   * @param  {String} options.dbName         The IndexedDB name (default: `"KintoDB"`)
   * @param  {String} options.migrateOldData Whether old database data should be migrated (default: `false`)
   */
  constructor(
    cid: string,
    options: { dbName?: string; migrateOldData?: boolean } = {}
  ) {
    super();

    this.cid = cid;
    this.dbName = options.dbName || "KintoDB";

    this._options = options;
    this._db = null;
  }

  _handleError(method: string, err: Error) {
    throw new IDBError(method, err);
  }

  /**
   * Ensures a connection to the IndexedDB database has been opened.
   *
   * @override
   * @return {Promise}
   */
  async open() {
    if (this._db) {
      return this;
    }

    // In previous versions, we used to have a database with name `${bid}/${cid}`.
    // Check if it exists, and migrate data once new schema is in place.
    // Note: the built-in migrations from IndexedDB can only be used if the
    // database name does not change.
    const dataToMigrate = this._options.migrateOldData
      ? await migrationRequired(this.cid)
      : null;

    this._db = await open(this.dbName, {
      version: 2,
      onupgradeneeded: (event: IDBVersionChangeEvent) => {
        const db = (event.target as IDBRequest<IDBDatabase>).result;

        if (event.oldVersion < 1) {
          // Records store
          const recordsStore = db.createObjectStore("records", {
            keyPath: ["_cid", "id"],
          });
          // An index to obtain all the records in a collection.
          recordsStore.createIndex("cid", "_cid");
          // Here we create indices for every known field in records by collection.
          // Local record status ("synced", "created", "updated", "deleted")
          recordsStore.createIndex("_status", ["_cid", "_status"]);
          // Last modified field
          recordsStore.createIndex("last_modified", ["_cid", "last_modified"]);
          // Timestamps store
          db.createObjectStore("timestamps", {
            keyPath: "cid",
          });
        }

        if (event.oldVersion < 2) {
          // Collections store
          db.createObjectStore("collections", {
            keyPath: "cid",
          });
        }
      },
    });

    if (dataToMigrate) {
      const { records, timestamp } = dataToMigrate;
      await this.importBulk(
        records as (B & {
          last_modified: number;
        })[]
      );
      await this.saveLastModified(timestamp ?? 0);
      console.log(`${this.cid}: data was migrated successfully.`);
      // Delete the old database.
      await deleteDatabase(this.cid);
      console.warn(`${this.cid}: old database was deleted.`);
    }

    return this;
  }

  /**
   * Closes current connection to the database.
   *
   * @override
   * @return {Promise}
   */
  close() {
    if (this._db) {
      this._db.close(); // indexedDB.close is synchronous
      this._db = null;
    }
    return Promise.resolve();
  }

  /**
   * Returns a transaction and an object store for a store name.
   *
   * To determine if a transaction has completed successfully, we should rather
   * listen to the transaction’s complete event rather than the IDBObjectStore
   * request’s success event, because the transaction may still fail after the
   * success event fires.
   *
   * @param  {String}      name  Store name
   * @param  {Function}    callback to execute
   * @param  {Object}      options Options
   * @param  {String}      options.mode  Transaction mode ("readwrite" or undefined)
   * @return {Object}
   */
  async prepare(
    name: string,
    callback: (store: IDBObjectStore, abort?: (...args: any[]) => any) => any,
    options?: { mode?: IDBTransactionMode }
  ) {
    await this.open();
    await execute(this._db!, name, callback, options);
  }

  /**
   * Deletes every records in the current collection.
   *
   * @override
   * @return {Promise}
   */
  async clear() {
    try {
      await this.prepare(
        "records",
        (store) => {
          const range = IDBKeyRange.only(this.cid);
          const request = store.index("cid").openKeyCursor(range);
          request.onsuccess = (event: Event) => {
            const cursor = (event.target as IDBRequest<IDBCursor>).result;
            if (cursor) {
              store.delete(cursor.primaryKey);
              cursor.continue();
            }
          };
          return request;
        },
        { mode: "readwrite" }
      );
    } catch (e: any) {
      this._handleError("clear", e);
    }
  }

  /**
   * Executes the set of synchronous CRUD operations described in the provided
   * callback within an IndexedDB transaction, for current db store.
   *
   * The callback will be provided an object exposing the following synchronous
   * CRUD operation methods: get, create, update, delete.
   *
   * Important note: because limitations in IndexedDB implementations, no
   * asynchronous code should be performed within the provided callback; the
   * promise will therefore be rejected if the callback returns a Promise.
   *
   * Options:
   * - {Array} preload: The list of record IDs to fetch and make available to
   *   the transaction object get() method (default: [])
   *
   * @example
   * const db = new IDB("example");
   * const result = await db.execute(transaction => {
   *   transaction.create({id: 1, title: "foo"});
   *   transaction.update({id: 2, title: "bar"});
   *   transaction.delete(3);
   *   return "foo";
   * });
   *
   * @override
   * @param  {Function} callback The operation description callback.
   * @param  {Object}   options  The options object.
   * @return {Promise}
   */
  async execute<T>(
    callback: (proxy: StorageProxy<B>) => T,
    options: { preload: string[] } = { preload: [] }
  ): Promise<T> {
    // Transactions in IndexedDB are autocommited when a callback does not
    // perform any additional operation.
    // The way Promises are implemented in Firefox (see https://bugzilla.mozilla.org/show_bug.cgi?id=1193394)
    // prevents using within an opened transaction.
    // To avoid managing asynchronocity in the specified `callback`, we preload
    // a list of record in order to execute the `callback` synchronously.
    // See also:
    // - http://stackoverflow.com/a/28388805/330911
    // - http://stackoverflow.com/a/10405196
    // - https://jakearchibald.com/2015/tasks-microtasks-queues-and-schedules/
    let result: T;
    await this.prepare(
      "records",
      (store, abort) => {
        const runCallback = (preloaded = {}) => {
          // Expose a consistent API for every adapter instead of raw store methods.
          const proxy = transactionProxy(this, store, preloaded);
          // The callback is executed synchronously within the same transaction.
          try {
            const returned = callback(proxy);
            if (returned instanceof Promise) {
              // XXX: investigate how to provide documentation details in error.
              throw new Error(
                "execute() callback should not return a Promise."
              );
            }
            // Bring to scope that will be returned (once promise awaited).
            result = returned;
          } catch (e) {
            // The callback has thrown an error explicitly. Abort transaction cleanly.
            abort && abort(e);
          }
        };

        // No option to preload records, go straight to `callback`.
        if (!options.preload) {
          return runCallback();
        }

        // Preload specified records using a list request.
        const filters = { id: options.preload };
        createListRequest(this.cid, store, filters, (records) => {
          // Store obtained records by id.
          const preloaded: { [key: string]: KintoObject } = {};
          for (const record of records) {
            delete record["_cid"];
            preloaded[record.id] = record;
          }
          runCallback(preloaded);
        });
      },
      { mode: "readwrite" }
    );
    return result!;
  }

  /**
   * Retrieve a record by its primary key from the IndexedDB database.
   *
   * @override
   * @param  {String} id The record id.
   * @return {Promise}
   */
  async get(id: string): Promise<B | undefined> {
    try {
      let record: B;
      await this.prepare("records", (store) => {
        store.get([this.cid, id]).onsuccess = (e) =>
          (record = (e.target as IDBRequest<KintoObject>).result as B);
      });
      return record!;
    } catch (e: any) {
      this._handleError("get", e);
    }
  }

  /**
   * Lists all records from the IndexedDB database.
   *
   * @override
   * @param  {Object} params  The filters and order to apply to the results.
   * @return {Promise}
   */
  async list(
    params: { filters: { [key: string]: any }; order?: string } = {
      filters: {},
    }
  ) {
    const { filters } = params;
    try {
      let results: KintoObject[] = [];
      await this.prepare("records", (store) => {
        createListRequest(this.cid, store, filters, (_results) => {
          // we have received all requested records that match the filters,
          // we now park them within current scope and hide the `_cid` attribute.
          for (const result of _results) {
            delete result["_cid"];
          }
          results = _results;
        });
      });
      // The resulting list of records is sorted.
      // XXX: with some efforts, this could be fully implemented using IDB API.
      return params.order ? sortObjects(params.order, results) : results;
    } catch (e: any) {
      this._handleError("list", e);
    }

    return [];
  }

  /**
   * Store the lastModified value into metadata store.
   *
   * @override
   * @param  {Number}  lastModified
   * @return {Promise}
   */
  async saveLastModified(lastModified: number): Promise<number | null> {
    const value = lastModified || null;
    try {
      await this.prepare(
        "timestamps",
        (store) => {
          if (value === null) {
            store.delete(this.cid);
          } else {
            store.put({ cid: this.cid, value });
          }
        },
        { mode: "readwrite" }
      );
      return value;
    } catch (e: any) {
      this._handleError("saveLastModified", e);
    }

    return null;
  }

  /**
   * Retrieve saved lastModified value.
   *
   * @override
   * @return {Promise}
   */
  async getLastModified(): Promise<number | null> {
    try {
      let entry = null as { value: number } | null;
      await this.prepare("timestamps", (store) => {
        store.get(this.cid).onsuccess = (e: Event) => {
          entry = (e.target as IDBRequest<{ value: number }>).result;
        };
      });

      return entry ? entry.value : null;
    } catch (e: any) {
      this._handleError("getLastModified", e);
    }

    return null;
  }

  /**
   * Load a dump of records exported from a server.
   *
   * @deprecated Use {@link importBulk} instead.
   * @abstract
   * @param  {Array} records The records to load.
   * @return {Promise}
   */
  async loadDump(
    records: (B & {
      last_modified: number;
    })[]
  ) {
    return this.importBulk(records);
  }

  /**
   * Load records in bulk that were exported from a server.
   *
   * @abstract
   * @param  {Array} records The records to load.
   * @return {Promise}
   */
  async importBulk(records: (B & { last_modified: number })[]): Promise<B[]> {
    try {
      await this.execute((transaction) => {
        // Since the put operations are asynchronous, we chain
        // them together. The last one will be waited for the
        // `transaction.oncomplete` callback. (see #execute())
        let i = 0;
        putNext();

        function putNext() {
          if (i === records.length) {
            return;
          }
          // On error, `transaction.onerror` is called.
          transaction.update(records[i]).onsuccess = putNext;
          ++i;
        }
      });
      const previousLastModified = await this.getLastModified();
      const lastModified = Math.max(
        ...records.map((record) => record.last_modified)
      );
      if (previousLastModified && lastModified > previousLastModified) {
        await this.saveLastModified(lastModified);
      }
      return records;
    } catch (e: any) {
      this._handleError("importBulk", e);
    }

    return [];
  }

  async saveMetadata(metadata: any) {
    try {
      await this.prepare(
        "collections",
        (store) => store.put({ cid: this.cid, metadata }),
        { mode: "readwrite" }
      );
      return metadata;
    } catch (e: any) {
      this._handleError("saveMetadata", e);
    }
  }

  async getMetadata() {
    try {
      let entry: { metadata: any } | null = null;
      await this.prepare("collections", (store: IDBObjectStore) => {
        store.get(this.cid).onsuccess = (e: Event) =>
          (entry = (e.target as IDBRequest<{ metadata: any }>).result);
      });
      return entry ? (entry as { metadata: any }).metadata : null;
    } catch (e: any) {
      this._handleError("getMetadata", e);
    }
  }
}

/**
 * IDB transaction proxy.
 *
 * @param  {IDB} adapter        The call IDB adapter
 * @param  {IDBStore} store     The IndexedDB database store.
 * @param  {Array}    preloaded The list of records to make available to
 *                              get() (default: []).
 * @return {Object}
 */
function transactionProxy<
  T extends { id: string; last_modified?: number; _status?: RecordStatus }
>(
  adapter: IDB<T>,
  store: IDBObjectStore,
  preloaded: { [key: string]: T } = {}
) {
  const _cid = adapter.cid;
  return {
    create(record: T) {
      store.add({ ...record, _cid });
    },

    update(record: T) {
      return store.put({ ...record, _cid });
    },

    delete(id: string) {
      store.delete([_cid, id]);
    },

    get(id: string) {
      return preloaded[id];
    },
  };
}

/**
 * Up to version 10.X of kinto.js, each collection had its own collection.
 * The database name was `${bid}/${cid}` (eg. `"blocklists/certificates"`)
 * and contained only one store with the same name.
 */
async function migrationRequired<
  T extends { id: string; last_modified?: number; _status?: RecordStatus }
>(dbName: string): Promise<{ records: T[]; timestamp: number | null } | null> {
  let exists = true;
  const db = await open(dbName, {
    version: 1,
    onupgradeneeded: (event) => {
      exists = false;
    },
  });

  // Check that the DB we're looking at is really a legacy one,
  // and not some remainder of the open() operation above.
  exists =
    db.objectStoreNames.contains("__meta__") &&
    db.objectStoreNames.contains(dbName);

  if (!exists) {
    db.close();
    // Testing the existence creates it, so delete it :)
    await deleteDatabase(dbName);
    return null;
  }

  console.warn(`${dbName}: old IndexedDB database found.`);
  try {
    // Scan all records.
    let records: T[];
    await execute(db, dbName, (store) => {
      store.openCursor().onsuccess = cursorHandlers.all(
        {},
        (res) => (records = res as T[])
      );
    });
    console.log(`${dbName}: found ${records!.length} records.`);

    // Check if there's a entry for this.
    let timestamp: number | null = null;
    await execute(db, "__meta__", (store) => {
      store.get(`${dbName}-lastModified`).onsuccess = (e: Event) => {
        timestamp = (e.target as IDBRequest).result
          ? (e.target as IDBRequest<{ value: number }>).result.value
          : null;
      };
    });
    // Some previous versions, also used to store the timestamps without prefix.
    if (!timestamp) {
      await execute(db, "__meta__", (store) => {
        store.get("lastModified").onsuccess = (e: Event) => {
          timestamp = (e.target as IDBRequest).result
            ? (e.target as IDBRequest<{ value: number }>).result.value
            : null;
        };
      });
    }
    console.log(`${dbName}: ${timestamp ? "found" : "no"} timestamp.`);

    // Those will be inserted in the new database/schema.
    return { records: records!, timestamp };
  } catch (e) {
    console.error("Error occured during migration", e);
    return null;
  } finally {
    db.close();
  }
}
