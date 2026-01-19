// Mock geotiff module globally to avoid ESM import issues in Jest
// The geotiff package and its dependency quick-lru use ESM syntax which
// Jest cannot parse by default. Tests that need the real geotiff module
// can unmock it or use jest.requireActual().
jest.mock("geotiff", () => ({
  fromArrayBuffer: jest.fn(),
}));
