/** Small inline icon set. Stroke-based so they read at 14–16 px on dark chrome. */

interface IconProps {
  size?: number;
  className?: string;
}

function svg(path: React.ReactNode, size: number, className?: string) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {path}
    </svg>
  );
}

export const IconCursor = ({ size = 16, className }: IconProps) =>
  svg(<path d="M4 3l7 17 2.5-6.5L20 11z" />, size, className);

export const IconHand = ({ size = 16, className }: IconProps) =>
  svg(
    <>
      <path d="M10 11V5.5a1.5 1.5 0 013 0V11" />
      <path d="M13 11V4.5a1.5 1.5 0 013 0V11" />
      <path d="M16 11.5V7a1.5 1.5 0 013 0v7a7 7 0 01-7 7h-1a6 6 0 01-4.5-2L4 15.5a1.5 1.5 0 012-2.2l2 1.7" />
      <path d="M10 11V8a1.5 1.5 0 00-3 0v6" />
    </>,
    size,
    className,
  );

export const IconTerritory = ({ size = 16, className }: IconProps) =>
  svg(<path d="M4 8l5-4 6 3 5-2v11l-5 2-6-3-5 4z" />, size, className);

export const IconVertex = ({ size = 16, className }: IconProps) =>
  svg(
    <>
      <path d="M5 18L9 7l7 3 3 8z" />
      <circle cx="5" cy="18" r="1.8" fill="currentColor" />
      <circle cx="9" cy="7" r="1.8" fill="currentColor" />
      <circle cx="16" cy="10" r="1.8" fill="currentColor" />
      <circle cx="19" cy="18" r="1.8" fill="currentColor" />
    </>,
    size,
    className,
  );

export const IconPaint = ({ size = 16, className }: IconProps) =>
  svg(
    <>
      <rect x="3" y="4" width="13" height="6" rx="1" />
      <path d="M16 7h3a2 2 0 012 2v2a2 2 0 01-2 2h-8" />
      <path d="M11 13v3M9.5 16h3v5h-3z" />
    </>,
    size,
    className,
  );

export const IconCut = ({ size = 16, className }: IconProps) =>
  svg(
    <>
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="18" r="2.5" />
      <path d="M7.8 16.2L18 4M16.2 16.2L6 4" />
    </>,
    size,
    className,
  );

export const IconSettlement = ({ size = 16, className }: IconProps) =>
  svg(
    <>
      <circle cx="12" cy="12" r="4" />
      <circle cx="12" cy="12" r="1" fill="currentColor" />
    </>,
    size,
    className,
  );

export const IconLabel = ({ size = 16, className }: IconProps) =>
  svg(<path d="M5 6h14M12 6v13M9 19h6" />, size, className);

export const IconRiver = ({ size = 16, className }: IconProps) =>
  svg(
    <>
      <path d="M3 7c3 0 3 3 6 3s3-3 6-3 3 3 6 3" />
      <path d="M3 15c3 0 3 3 6 3s3-3 6-3 3 3 6 3" />
    </>,
    size,
    className,
  );

export const IconRoad = ({ size = 16, className }: IconProps) =>
  svg(
    <>
      <path d="M7 3L4 21M17 3l3 18" />
      <path d="M12 4v3M12 11v3M12 18v3" />
    </>,
    size,
    className,
  );

export const IconMeasure = ({ size = 16, className }: IconProps) =>
  svg(
    <>
      <rect x="2" y="9" width="20" height="6" rx="1" transform="rotate(-12 12 12)" />
      <path d="M6 9.5v2M10 8.5v3M14 7.5v2M18 6.5v3" />
    </>,
    size,
    className,
  );

export const IconUndo = ({ size = 15, className }: IconProps) =>
  svg(<path d="M4 9h11a5 5 0 010 10h-6M4 9l4-4M4 9l4 4" />, size, className);

export const IconRedo = ({ size = 15, className }: IconProps) =>
  svg(<path d="M20 9H9a5 5 0 000 10h6M20 9l-4-4M20 9l-4 4" />, size, className);

export const IconEye = ({ size = 13, className }: IconProps) =>
  svg(
    <>
      <path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z" />
      <circle cx="12" cy="12" r="2.5" />
    </>,
    size,
    className,
  );

export const IconEyeOff = ({ size = 13, className }: IconProps) =>
  svg(
    <>
      <path d="M9.9 5.7A10.6 10.6 0 0112 5.5c6.4 0 10 6.5 10 6.5a17 17 0 01-3.2 4M6.3 7.8A16.7 16.7 0 002 12s3.6 6.5 10 6.5c1.5 0 2.8-.3 4-.8" />
      <path d="M3 3l18 18" />
    </>,
    size,
    className,
  );

export const IconLock = ({ size = 13, className }: IconProps) =>
  svg(
    <>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V7.5a4 4 0 018 0V11" />
    </>,
    size,
    className,
  );

export const IconUnlock = ({ size = 13, className }: IconProps) =>
  svg(
    <>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V7.5a4 4 0 017.5-2" />
    </>,
    size,
    className,
  );

export const IconPlus = ({ size = 13, className }: IconProps) =>
  svg(<path d="M12 5v14M5 12h14" />, size, className);

export const IconTrash = ({ size = 13, className }: IconProps) =>
  svg(
    <>
      <path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" />
    </>,
    size,
    className,
  );

export const IconCopy = ({ size = 13, className }: IconProps) =>
  svg(
    <>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2" />
    </>,
    size,
    className,
  );

export const IconChevronDown = ({ size = 10, className }: IconProps) =>
  svg(<path d="M6 9l6 6 6-6" />, size, className);

export const IconChevronRight = ({ size = 10, className }: IconProps) =>
  svg(<path d="M9 6l6 6-6 6" />, size, className);

export const IconArrowUp = ({ size = 12, className }: IconProps) =>
  svg(<path d="M12 19V5M5 12l7-7 7 7" />, size, className);

export const IconArrowDown = ({ size = 12, className }: IconProps) =>
  svg(<path d="M12 5v14M5 12l7 7 7-7" />, size, className);

export const IconZoomIn = ({ size = 14, className }: IconProps) =>
  svg(
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-4.4-4.4M11 8v6M8 11h6" />
    </>,
    size,
    className,
  );

export const IconZoomOut = ({ size = 14, className }: IconProps) =>
  svg(
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-4.4-4.4M8 11h6" />
    </>,
    size,
    className,
  );

export const IconFit = ({ size = 14, className }: IconProps) =>
  svg(
    <>
      <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
    </>,
    size,
    className,
  );

export const IconSearch = ({ size = 13, className }: IconProps) =>
  svg(
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-4.4-4.4" />
    </>,
    size,
    className,
  );

export const IconGrid = ({ size = 14, className }: IconProps) =>
  svg(
    <>
      <rect x="3" y="3" width="18" height="18" rx="1" />
      <path d="M3 9h18M3 15h18M9 3v18M15 3v18" />
    </>,
    size,
    className,
  );

export const IconLayers = ({ size = 14, className }: IconProps) =>
  svg(
    <>
      <path d="M12 3l9 5-9 5-9-5z" />
      <path d="M3 13l9 5 9-5" />
    </>,
    size,
    className,
  );
