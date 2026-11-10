Added

- **A bundle with no jobs and no pipelines opens on a bundle overview** ([#377](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/377)). Every resource in the bundle is a box, in two columns: what runs or shows data, and the compute, secrets and data those use. A line joins two boxes where the bundle's settings link them. Click a box to see where it is defined and what it is linked to. Resource types the inspector has no checks for are marked "not checked yet". Before, the panel only named the resource groups.
