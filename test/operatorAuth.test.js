'use strict';

/**
 * Unit tests for src/middleware/operatorAuth.js
 *
 * Each test builds lightweight mock req/res objects so we don't need a
 * running Express server. The OPERATOR_API_KEY env var is set/unset around
 * each test to keep them independent.
 *
 * Validates: Requirements 11.5
 */

const operatorAuth = require('../src/middleware/operatorAuth');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal mock Express request with optional Authorization header. */
function mockReq(authHeader) {
  return {
    headers: authHeader ? { authorization: authHeader } : {},
  };
}

/** Build a minimal mock Express response that records status + json body. */
function mockRes() {
  const res = {
    _status: null,
    _body: null,
  };
  res.status = function (code) {
    res._status = code;
    return res;
  };
  res.json = function (body) {
    res._body = body;
    return res;
  };
  return res;
}

// ---------------------------------------------------------------------------
// Save and restore OPERATOR_API_KEY around each test
// ---------------------------------------------------------------------------

let savedKey;
beforeEach(() => {
  savedKey = process.env.OPERATOR_API_KEY;
});
afterEach(() => {
  if (savedKey === undefined) {
    delete process.env.OPERATOR_API_KEY;
  } else {
    process.env.OPERATOR_API_KEY = savedKey;
  }
});

// ---------------------------------------------------------------------------
// Tests: OPERATOR_API_KEY not set
// ---------------------------------------------------------------------------

describe('operatorAuth — OPERATOR_API_KEY not configured', () => {
  it('returns 500 with "Operator API not configured" when env var is absent', () => {
    delete process.env.OPERATOR_API_KEY;

    const req = mockReq('Bearer sometoken');
    const res = mockRes();
    const next = vi.fn();

    operatorAuth(req, res, next);

    expect(res._status).toBe(500);
    expect(res._body).toEqual({ error: 'Operator API not configured' });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 500 even when no Authorization header is provided', () => {
    delete process.env.OPERATOR_API_KEY;

    const req = mockReq();
    const res = mockRes();
    const next = vi.fn();

    operatorAuth(req, res, next);

    expect(res._status).toBe(500);
    expect(res._body).toEqual({ error: 'Operator API not configured' });
    expect(next).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests: valid key, various Authorization header scenarios
// ---------------------------------------------------------------------------

describe('operatorAuth — with OPERATOR_API_KEY set', () => {
  beforeEach(() => {
    process.env.OPERATOR_API_KEY = 'super-secret-key-123';
  });

  it('calls next() when the Bearer token matches exactly', () => {
    const req = mockReq('Bearer super-secret-key-123');
    const res = mockRes();
    const next = vi.fn();

    operatorAuth(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res._status).toBeNull();
  });

  it('returns 401 when the Authorization header is absent', () => {
    const req = mockReq();
    const res = mockRes();
    const next = vi.fn();

    operatorAuth(req, res, next);

    expect(res._status).toBe(401);
    expect(res._body).toEqual({ error: 'Unauthorized' });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when the Authorization header does not start with "Bearer "', () => {
    const req = mockReq('Basic super-secret-key-123');
    const res = mockRes();
    const next = vi.fn();

    operatorAuth(req, res, next);

    expect(res._status).toBe(401);
    expect(res._body).toEqual({ error: 'Unauthorized' });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when the Bearer token is wrong', () => {
    const req = mockReq('Bearer wrong-token');
    const res = mockRes();
    const next = vi.fn();

    operatorAuth(req, res, next);

    expect(res._status).toBe(401);
    expect(res._body).toEqual({ error: 'Unauthorized' });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when the Bearer token is an empty string after "Bearer "', () => {
    const req = mockReq('Bearer ');
    const res = mockRes();
    const next = vi.fn();

    operatorAuth(req, res, next);

    expect(res._status).toBe(401);
    expect(res._body).toEqual({ error: 'Unauthorized' });
    expect(next).not.toHaveBeenCalled();
  });

  it('does exact string match — prefix of the correct token is rejected', () => {
    // "super-secret-key" is a prefix of "super-secret-key-123"
    const req = mockReq('Bearer super-secret-key');
    const res = mockRes();
    const next = vi.fn();

    operatorAuth(req, res, next);

    expect(res._status).toBe(401);
    expect(res._body).toEqual({ error: 'Unauthorized' });
    expect(next).not.toHaveBeenCalled();
  });

  it('does exact string match — token with trailing whitespace is rejected', () => {
    const req = mockReq('Bearer super-secret-key-123 ');
    const res = mockRes();
    const next = vi.fn();

    operatorAuth(req, res, next);

    expect(res._status).toBe(401);
    expect(res._body).toEqual({ error: 'Unauthorized' });
    expect(next).not.toHaveBeenCalled();
  });
});
