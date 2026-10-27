/**
 * Jupyter files and whether CLI 0.299.0 and 1.21.0 take each one as a notebook. The
 * last three are where the inspector still differs from the CLI (see notebookFiles.ts).
 */
export const JUPYTER_CASES: Array<{ name: string; text: string; cli: boolean; inspector: boolean }> = [
  { name: "ok", text: '{"cells":[],"metadata":{},"nbformat":4,"nbformat_minor":5}', cli: true, inspector: true },
  { name: "any_cells", text: '{"cells":[1,"a"],"metadata":{},"nbformat":4}', cli: true, inspector: true },
  { name: "minor_null", text: '{"cells":[],"metadata":{},"nbformat":4,"nbformat_minor":null}', cli: true, inspector: true },
  { name: "metadata_list", text: '{"cells":[],"metadata":[],"nbformat":4,"nbformat_minor":5}', cli: false, inspector: false },
  { name: "metadata_null", text: '{"cells":[],"metadata":null,"nbformat":4}', cli: false, inspector: false },
  { name: "metadata_text", text: '{"cells":[],"metadata":"x","nbformat":4}', cli: false, inspector: false },
  { name: "cells_null", text: '{"cells":null,"metadata":{},"nbformat":4}', cli: false, inspector: false },
  { name: "cells_object", text: '{"cells":{},"metadata":{},"nbformat":4}', cli: false, inspector: false },
  { name: "nbformat_fraction", text: '{"cells":[],"metadata":{},"nbformat":4.5}', cli: false, inspector: false },
  { name: "nbformat_text", text: '{"cells":[],"metadata":{},"nbformat":"4"}', cli: false, inspector: false },
  { name: "nbformat_missing", text: '{"cells":[],"metadata":{}}', cli: false, inspector: false },
  { name: "minor_text", text: '{"cells":[],"metadata":{},"nbformat":4,"nbformat_minor":"x"}', cli: false, inspector: false },
  { name: "minor_fraction", text: '{"cells":[],"metadata":{},"nbformat":4,"nbformat_minor":1.5}', cli: false, inspector: false },
  { name: "top_list", text: '[{"cells":[],"metadata":{},"nbformat":4}]', cli: false, inspector: false },
  { name: "nbformat_4_0", text: '{"cells":[],"metadata":{},"nbformat":4.0}', cli: false, inspector: true },
  { name: "text_after", text: '{"cells":[],"metadata":{},"nbformat":4} trailing', cli: true, inspector: false },
  { name: "key_case", text: '{"Cells":[],"METADATA":{},"NbFormat":4}', cli: true, inspector: false },
];
