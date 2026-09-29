/** Line icons for the chat layout: 20px, stroke follows the text colour. */
const Svg = ({ children, size = 20 }: { children: React.ReactNode; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

export const IconPlus = () => (
  <Svg>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);
export const IconPanel = () => (
  <Svg>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
    <path d="M9.5 4.5v15" />
  </Svg>
);
export const IconConsole = () => (
  <Svg>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
    <path d="m7.5 10 2.5 2-2.5 2M12.5 14.5h4" />
  </Svg>
);
export const IconWallet = () => (
  <Svg>
    <path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H18v3" />
    <rect x="4" y="8" width="16.5" height="11" rx="2.5" />
    <circle cx="16" cy="13.5" r="1.2" />
  </Svg>
);
export const IconNode = () => (
  <Svg>
    <rect x="4" y="4.5" width="16" height="6" rx="2" />
    <rect x="4" y="13.5" width="16" height="6" rx="2" />
    <path d="M8 7.5h.01M8 16.5h.01" />
  </Svg>
);
export const IconChevron = () => (
  <Svg size={16}>
    <path d="m6 9 6 6 6-6" />
  </Svg>
);
export const IconArrowUp = () => (
  <Svg size={18}>
    <path d="M12 19V5M6 11l6-6 6 6" />
  </Svg>
);
export const IconStop = () => (
  <svg width={14} height={14} viewBox="0 0 14 14" aria-hidden="true">
    <rect x="2" y="2" width="10" height="10" rx="2" fill="currentColor" />
  </svg>
);
export const IconMenu = () => (
  <Svg>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Svg>
);
export const IconTrash = () => (
  <Svg size={18}>
    <path d="M5 7h14M10 11v6M14 11v6M6.5 7l1 12h9l1-12M9.5 7V4.5h5V7" />
  </Svg>
);
export const IconCheck = () => (
  <Svg size={16}>
    <path d="m5 12 5 5 9-10" />
  </Svg>
);
export const IconPen = () => (
  <Svg size={18}>
    <path d="M4 20h4L19 9l-4-4L4 16v4ZM13.5 6.5l4 4" />
  </Svg>
);
export const IconBook = () => (
  <Svg size={18}>
    <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H11v16H5.5A1.5 1.5 0 0 1 4 18.5v-13ZM20 5.5A1.5 1.5 0 0 0 18.5 4H13v16h5.5a1.5 1.5 0 0 0 1.5-1.5v-13Z" />
  </Svg>
);
export const IconCode = () => (
  <Svg size={18}>
    <path d="m8 8-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14" />
  </Svg>
);
export const IconChart = () => (
  <Svg size={18}>
    <path d="M4 20h16M7 16v-5M12 16V7M17 16v-8" />
  </Svg>
);
export const IconBulb = () => (
  <Svg size={18}>
    <path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3Z" />
  </Svg>
);
export const IconLogout = () => (
  <Svg size={18}>
    <path d="M15 4.5h3.5A1.5 1.5 0 0 1 20 6v12a1.5 1.5 0 0 1-1.5 1.5H15M10 16l-4-4 4-4M6 12h10" />
  </Svg>
);
export const IconGear = () => (
  <Svg size={18}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
  </Svg>
);
export const IconGauge = () => (
  <Svg size={18}>
    <path d="M4.5 17a8.5 8.5 0 1 1 15 0M12 13l3.5-4" />
    <circle cx="12" cy="13.5" r="1.2" />
  </Svg>
);
export const IconHelp = () => (
  <Svg size={18}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M9.6 9.5a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .8-1 1.5v.4M12 16.8h.01" />
  </Svg>
);
export const IconDownload = () => (
  <Svg size={18}>
    <path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14" />
  </Svg>
);
export const IconUsers = () => (
  <Svg size={18}>
    <circle cx="9" cy="8.5" r="3" />
    <path d="M3.5 19a5.5 5.5 0 0 1 11 0M16 5.8a3 3 0 0 1 0 5.4M17.5 14.3a5.5 5.5 0 0 1 3 4.7" />
  </Svg>
);
export const IconInfo = () => (
  <Svg size={18}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 11v5.5M12 7.8h.01" />
  </Svg>
);
export const IconRight = () => (
  <Svg size={16}>
    <path d="m9 6 6 6-6 6" />
  </Svg>
);
export const IconClip = () => (
  <Svg size={18}>
    <path d="m20 11.5-7.8 7.8a5 5 0 0 1-7-7l8.3-8.4a3.3 3.3 0 0 1 4.7 4.7L9.9 17a1.7 1.7 0 0 1-2.4-2.4l7.4-7.3" />
  </Svg>
);
export const IconRoute = () => (
  <Svg size={18}>
    <circle cx="6" cy="18" r="2" />
    <circle cx="18" cy="6" r="2" />
    <path d="M8 18h6.5a3.5 3.5 0 0 0 0-7h-5a3.5 3.5 0 0 1 0-7H16" />
  </Svg>
);
export const IconLeaf = () => (
  <Svg size={18}>
    <path d="M5 19c0-8 5-13 14-14 0 9-5 14-13 14M5 19l7-7" />
  </Svg>
);
export const IconLock = () => (
  <Svg size={18}>
    <rect x="5" y="10.5" width="14" height="9.5" rx="2" />
    <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
  </Svg>
);
export const IconX = () => (
  <Svg size={14}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Svg>
);
export const IconMic = () => (
  <Svg>
    <rect x="9" y="3.5" width="6" height="11" rx="3" />
    <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
  </Svg>
);
export const IconSpeaker = () => (
  <Svg size={14}>
    <path d="M4 9.5h3l4.5-4v13l-4.5-4H4z" />
    <path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" />
  </Svg>
);
