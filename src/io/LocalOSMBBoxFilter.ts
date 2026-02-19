export function buildBBoxFilter(
  bbox: GeoJSON.BBox | null,
  geomColumn: string,
  startParamIndex: number,
): { clause: string; params: number[] } {
  if (!bbox) {
    return { clause: "TRUE", params: [] };
  }

  const [west, south, east, north] = bbox;
  const clause = `ST_Intersects(${geomColumn}, ST_Transform(ST_MakeEnvelope($${startParamIndex}, $${startParamIndex + 1}, $${startParamIndex + 2}, $${startParamIndex + 3}, 4326), 3857))`;
  return { clause, params: [west, south, east, north] };
}
