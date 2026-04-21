const BaseSvg = ({ color, size = 17, children, ...props }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{ flexShrink: 0 }}
    {...props}
  >
    {children}
  </svg>
);

export const IconNotebook = ({ color, size = 17 }) => (
  <BaseSvg color={color} size={size}>
    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
    <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
  </BaseSvg>
);

export const IconJob = ({ color, size = 17 }) => (
  <BaseSvg color={color} size={size}>
    {/* A list/task representation with a play indicator */}
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M7 10h3" />
    <path d="M7 14h3" />
    <path d="M14 10l3 2-3 2v-4z" />
  </BaseSvg>
);

export const IconCode = ({ color, size = 17 }) => (
  <BaseSvg color={color} size={size}>
    <polyline points="16 18 22 12 16 6" />
    <polyline points="8 6 2 12 8 18" />
  </BaseSvg>
);

export const IconSql = ({ color, size = 17 }) => (
  <BaseSvg color={color} size={size}>
    <ellipse cx="12" cy="6" rx="7" ry="3" />
    <path d="M5 6v8c0 1.66 3.13 3 7 3s7-1.34 7-3V6" />
    <path d="M5 10c0 1.66 3.13 3 7 3s7-1.34 7-3" />
  </BaseSvg>
);

export const IconPipeline = ({ color, size = 17 }) => (
  <BaseSvg color={color} size={size}>
    {/* Nodes connected in a sequence */}
    <path d="M3 12h3" />
    <path d="M18 12h3" />
    <circle cx="9" cy="12" r="3" />
    <circle cx="15" cy="12" r="3" />
    {/* Optional: Add a "delta" or flow feel with an arrow head */}
    <polyline points="12 8 12 16" />
  </BaseSvg>
);

export const IconSecretScope = ({ color, size = 17 }) => (
  <BaseSvg color={color} size={size}>
    <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3-3.5 3.5z" />
  </BaseSvg>
);

export const IconVolume = ({ color, size = 17 }) => (
  <BaseSvg color={color} size={size}>
    <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
    <path d="m3.3 7 8.7 5 8.7-5" />
    <path d="M12 22V12" />
  </BaseSvg>
);

export const IconServicePrincipal = ({ color, size = 17 }) => (
  <BaseSvg color={color} size={size}>
    {/* Robot / Bot Head */}
    <rect x="8" y="3" width="8" height="8" rx="1.5" />
    <path d="M12 3V1" />
    <path d="M8 15h8" />
    {/* Robot Body */}
    <path d="M20 15a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z" />
    {/* Eyes */}
    <circle cx="10" cy="7" r="0.5" fill={color} />
    <circle cx="14" cy="7" r="0.5" fill={color} />
  </BaseSvg>
);

export const IconUser = ({ color, size = 17 }) => (
  <BaseSvg color={color} size={size}>
    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
    <circle cx="12" cy="7" r="4" />
  </BaseSvg>
);

// Cluster: Represents a node or group of compute
export const IconCluster = ({ color, size = 17 }) => (
  <BaseSvg color={color} size={size}>
    {/* Master Node (The Server at the top) */}
    <rect x="7" y="2" width="10" height="7" rx="1" />
    <circle cx="10" cy="5.5" r="0.5" fill={color} />

    {/* Connection Lines */}
    <path d="M12 9v4" />
    <path d="M5 13h14" />
    <path d="M5 13v3" />
    <path d="M12 13v3" />
    <path d="M19 13v3" />

    {/* Worker Nodes */}
    <rect x="3" y="16" width="4" height="4" rx="0.5" />
    <rect x="10" y="16" width="4" height="4" rx="0.5" />
    <rect x="17" y="16" width="4" height="4" rx="0.5" />
  </BaseSvg>
);

// Alert: Notification (Bell)
export const IconAlert = ({ color, size = 17 }) => (
  <BaseSvg color={color} size={size}>
    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
    <path d="M13.73 21a2 2 0 0 1-3.46 0" />
  </BaseSvg>
);

// Dashboard: Insights (Layout Grid)
export const IconDashboard = ({ color, size = 17 }) => (
  <BaseSvg color={color} size={size}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M3 9h18M9 21V9" />
  </BaseSvg>
);

// TODO: Add resources: Model Serving, Postgres, App

const ICON_COMPONENTS = {
  notebook: IconNotebook,
  job: IconJob,
  sql: IconSql,
  script: IconCode,
  pipeline: IconPipeline,
  secretScope: IconSecretScope,
  volume: IconVolume,
  servicePrincipal: IconServicePrincipal,
  user: IconUser,
  cluster: IconCluster,
  sqlWarehouse: IconCluster,
  alert: IconAlert,
  dashboard: IconDashboard,
};

export const KindIcon = ({ kind, color, size = 17 }) => {
  const IconComponent = ICON_COMPONENTS[kind];

  if (!IconComponent) return null;

  return (
    <span aria-hidden="true" style={{ display: "inline-flex" }}>
      <IconComponent color={color} size={size} />
    </span>
  );
};
