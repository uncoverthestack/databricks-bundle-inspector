import type { OverviewItem } from "../../bundle/bundleOverview.js";
import { telemetryResourceType, type TelemetryProperties } from "../../telemetry/schema.js";

/** Only an explicit selection of a different box counts; closing or restoring details doesn't. */
export function resourceSelectionProperties(
  item: Pick<OverviewItem, "id" | "kind"> | undefined,
  previousId: string | null | undefined,
): TelemetryProperties | undefined {
  return item && item.id !== previousId ? { resource_type: telemetryResourceType(item.kind) } : undefined;
}
