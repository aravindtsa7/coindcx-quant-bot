import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/api/app';

describe('Health & API Endpoints Integration', () => {
  const app = createApp();

  it('GET /health returns 200 with service information and ok status', async () => {
    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('status', 'ok');
    expect(response.body).toHaveProperty('service', 'coindcx-quant-bot');
    expect(response.body).toHaveProperty('timestamp');
    expect(response.body).toHaveProperty('uptimeSeconds');
    expect(typeof response.body.uptimeSeconds).toBe('number');
    expect(response.body.database).toBeUndefined();
  });

  it('GET /health?db=true probes database without exposing credentials or internal error stack', async () => {
    const response = await request(app).get('/health?db=true');

    // Status is either 200 (ok) or 503 (degraded) depending on local MySQL availability
    expect([200, 503]).toContain(response.status);
    expect(response.body).toHaveProperty('database');
    expect(typeof response.body.database.connected).toBe('boolean');

    // Critical: ensure credentials, passwords or connection URLs are never returned
    const jsonString = JSON.stringify(response.body);
    expect(jsonString).not.toContain('password');
    expect(jsonString).not.toContain('mysql://');
  });

  it('GET /unknown-route returns 404 with structured NOT_FOUND_ERROR', async () => {
    const response = await request(app).get('/unknown-route');

    expect(response.status).toBe(404);
    expect(response.body).toHaveProperty('status', 'error');
    expect(response.body).toHaveProperty('code', 'NOT_FOUND_ERROR');
    expect(response.body.message).toContain('Endpoint not found: GET /unknown-route');
  });
});
