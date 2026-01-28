import { SkiAreaFeature, SkiAreaSummaryFeature } from "openskidata-format";
import { SkiAreaAssignmentSource } from "../clustering/MapObject";

export function toSkiAreaSummary(
  skiArea: SkiAreaFeature,
): SkiAreaSummaryFeature {
  const properties = skiArea.properties;
  return {
    type: "Feature",
    properties: {
      id: properties.id,
      name: properties.name,
      activities: properties.activities,
      type: properties.type,
      status: properties.status,
    },
    geometry: skiArea.geometry,
  };
}

export function toSkiAreaSummaryWithAssignment(
  skiArea: SkiAreaFeature,
  assignedFrom: SkiAreaAssignmentSource,
): SkiAreaSummaryFeature & {
  properties: { assignedFrom: SkiAreaAssignmentSource };
} {
  const properties = skiArea.properties;
  return {
    type: "Feature",
    properties: {
      id: properties.id,
      name: properties.name,
      activities: properties.activities,
      type: properties.type,
      status: properties.status,
      assignedFrom: assignedFrom,
    },
    geometry: skiArea.geometry,
  };
}
