'use strict';

/**
 * Tests for storeRegistry + settingsStore
 *
 * Each test gets a fresh in-memory SQLite database so there is no
 * cross-test pollution. We reset the module registry before every test
 * so the module-level `db` handle inside storeRegistry.js is cleared.
 *
 * Vitest injects globals (describe, it, expect, vi, beforeEach) in CJS
 * mode — no require('vitest') needed.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Re-require both modules against a fresh in-memory DB and return them. */
function freshModules() {
  vi.resetModules();
  // After resetModules the require cache is cleared; next require is fresh.
  const registry = require('../src/services/storeRegistry');
  const settings = require('../src/services/settingsStore');
  registry.initDb(':memory:');
  return { registry, settings };
}

/** Convenience: register a test store with sensible defaults. */
function registerTestStore(registry, overrides) {
  return registry.registerStore(
    Object.assign(
      {
        shopDomain: 'test.myshopify.com',
        adminApiToken: 'shpat_test123',
        adminUsername: 'admin',
        adminPassword: 'password123',
      },
      overrides || {}
    )
  );
}

// ---------------------------------------------------------------------------
// initDb
// ---------------------------------------------------------------------------

describe('initDb', () => {
  it('creates the database and tables without error', () => {
    const { registry } = freshModules();
    // If initDb threw, freshModules() would have thrown. We also verify the
    // db handle is available by calling listStores (which uses requireDb).
    expect(() => registry.listStores()).not.toThrow();
  });

  it('is idempotent — calling it twice does not throw', () => {
    const { registry } = freshModules();
    expect(() => registry.initDb(':memory:')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// registerStore + findStore
// ---------------------------------------------------------------------------

describe('registerStore + findStore', () => {
  it('persists a store and findStore returns the public record', () => {
    const { registry } = freshModules();
    registerTestStore(registry);

    const store = registry.findStore('test.myshopify.com');
    expect(store).not.toBeNull();
    expect(store.shopDomain).toBe('test.myshopify.com');
    expect(store.adminUsername).toBe('admin');
    expect(store).not.toHaveProperty('adminApiToken');
    expect(store).not.toHaveProperty('passwordHash');
  });

  it('returns null for an unregistered domain', () => {
    const { registry } = freshModules();
    expect(registry.findStore('nobody.myshopify.com')).toBeNull();
  });

  it('throws StoreDuplicateError on duplicate domain', () => {
    const { registry } = freshModules();
    registerTestStore(registry);
    expect(() => registerTestStore(registry)).toThrowError(registry.StoreDuplicateError);
  });

  it('throws on missing required fields', () => {
    const { registry } = freshModules();
    expect(() =>
      registry.registerStore({
        shopDomain: '',
        adminApiToken: 'tok',
        adminUsername: 'u',
        adminPassword: 'p',
      })
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// findStoreFull
// ---------------------------------------------------------------------------

describe('findStoreFull', () => {
  it('returns the full record including adminApiToken and passwordHash', () => {
    const { registry } = freshModules();
    registerTestStore(registry);

    const full = registry.findStoreFull('test.myshopify.com');
    expect(full).not.toBeNull();
    expect(full.shopDomain).toBe('test.myshopify.com');
    expect(full.adminApiToken).toBe('shpat_test123');
    expect(full.passwordHash).toBeTruthy();
    // passwordHash must be a bcrypt hash, not the raw password
    expect(full.passwordHash).not.toBe('password123');
    expect(full.passwordHash).toMatch(/^\$2[ab]\$/);
  });

  it('returns null for an unregistered domain', () => {
    const { registry } = freshModules();
    expect(registry.findStoreFull('nobody.myshopify.com')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// listStores
// ---------------------------------------------------------------------------

describe('listStores', () => {
  it('returns an empty array when no stores are registered', () => {
    const { registry } = freshModules();
    expect(registry.listStores()).toEqual([]);
  });

  it('returns domains without tokens or hashes', () => {
    const { registry } = freshModules();
    registerTestStore(registry, { shopDomain: 'a.myshopify.com' });
    registerTestStore(registry, { shopDomain: 'b.myshopify.com' });

    const list = registry.listStores();
    expect(list).toHaveLength(2);
    const domains = list.map(function (s) {
      return s.shopDomain;
    });
    expect(domains).toContain('a.myshopify.com');
    expect(domains).toContain('b.myshopify.com');
    // No sensitive fields
    list.forEach(function (s) {
      expect(s).not.toHaveProperty('adminApiToken');
      expect(s).not.toHaveProperty('passwordHash');
    });
  });
});

// ---------------------------------------------------------------------------
// deleteStore
// ---------------------------------------------------------------------------

describe('deleteStore', () => {
  it('removes the store and findStore returns null afterwards', () => {
    const { registry } = freshModules();
    registerTestStore(registry);

    registry.deleteStore('test.myshopify.com');
    expect(registry.findStore('test.myshopify.com')).toBeNull();
  });

  it('throws StoreNotFoundError when deleting a non-existent domain', () => {
    const { registry } = freshModules();
    expect(() => registry.deleteStore('ghost.myshopify.com')).toThrowError(
      registry.StoreNotFoundError
    );
  });
});

// ---------------------------------------------------------------------------
// settingsStore.getSettings
// ---------------------------------------------------------------------------

describe('settingsStore.getSettings', () => {
  it('returns seeded defaults after registration', () => {
    const { registry, settings } = freshModules();
    registerTestStore(registry);

    const s = settings.getSettings('test.myshopify.com');
    expect(s).not.toBeNull();
    expect(s).toHaveProperty('currencies');
    expect(s.currencies).toHaveProperty('USD');
    expect(s).toHaveProperty('dimensionalWeightDivisor');
    expect(typeof s.dimensionalWeightDivisor).toBe('number');
  });

  it('returns null for an unregistered domain', () => {
    const { registry, settings } = freshModules();
    void registry; // DB is initialised but no store is registered
    expect(settings.getSettings('nobody.myshopify.com')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// settingsStore.saveSettings
// ---------------------------------------------------------------------------

describe('settingsStore.saveSettings', () => {
  it('persists updated settings and getSettings reflects the change', () => {
    const { registry, settings } = freshModules();
    registerTestStore(registry);

    const updated = {
      currencies: { USD: 1, CAD: 1.5 },
      dimensionalWeightDivisor: 6000,
    };
    const saved = settings.saveSettings('test.myshopify.com', updated);
    expect(saved).toEqual(updated);

    const fetched = settings.getSettings('test.myshopify.com');
    expect(fetched).toEqual(updated);
  });

  it('throws StoreNotFoundError when saving settings for an unregistered domain', () => {
    const { registry, settings } = freshModules();
    const { StoreNotFoundError } = registry;
    expect(() =>
      settings.saveSettings('nobody.myshopify.com', {
        currencies: {},
        dimensionalWeightDivisor: 5000,
      })
    ).toThrowError(StoreNotFoundError);
  });
});
