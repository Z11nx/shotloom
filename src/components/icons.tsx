/** Small stroke icons (decorative: always aria-hidden; buttons carry their own labels). */
import type { ReactNode } from "react";

function Svg({ children, size = 14 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const BrandIcon = () => (
  <Svg size={18}>
    <rect x="1.5" y="3" width="13" height="10" rx="1.5" />
    <path d="M5.5 3v10" />
  </Svg>
);
export const PlusIcon = () => (
  <Svg>
    <path d="M8 3.5v9M3.5 8h9" />
  </Svg>
);
export const FolderIcon = () => (
  <Svg size={16}>
    <path d="M1.8 4.2c0-.6.5-1.1 1.1-1.1h3l1.4 1.5h5.8c.6 0 1.1.5 1.1 1.1v6.2c0 .6-.5 1.1-1.1 1.1H2.9c-.6 0-1.1-.5-1.1-1.1z" />
  </Svg>
);
export const ImportIcon = () => (
  <Svg>
    <path d="M8 10.5V3M5 6l3-3 3 3M3 10.5V13h10v-2.5" />
  </Svg>
);
export const ExportIcon = ImportIcon;
export const PlayIcon = () => (
  <Svg size={12}>
    <path d="M4.5 3.2v9.6L12.5 8z" fill="currentColor" />
  </Svg>
);
export const MusicIcon = () => (
  <Svg>
    <path d="M6 12.2V3.6l7-1.4v8.4" />
    <circle cx="4.4" cy="12.2" r="1.6" />
    <circle cx="11.4" cy="10.6" r="1.6" />
  </Svg>
);
export const MoreIcon = () => (
  <Svg>
    <circle cx="3.5" cy="8" r=".6" fill="currentColor" />
    <circle cx="8" cy="8" r=".6" fill="currentColor" />
    <circle cx="12.5" cy="8" r=".6" fill="currentColor" />
  </Svg>
);
export const ChevronLeft = () => (
  <Svg size={12}>
    <path d="M10 3.5 5.5 8l4.5 4.5" />
  </Svg>
);
export const ChevronRight = () => (
  <Svg size={12}>
    <path d="m6 3.5 4.5 4.5L6 12.5" />
  </Svg>
);
export const ExpandIcon = () => (
  <Svg size={12}>
    <path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9" />
  </Svg>
);
export const CheckIcon = () => (
  <Svg size={12}>
    <path d="m3.5 8.3 2.8 2.7 6.2-6.5" />
  </Svg>
);
