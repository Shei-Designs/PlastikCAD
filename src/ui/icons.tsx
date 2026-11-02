import type { ReactNode, SVGProps } from 'react';

const Icon = ({ children, ...rest }: SVGProps<SVGSVGElement> & { children: ReactNode }) => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
    {children}
  </svg>
);

export const SunIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </Icon>
);
export const MoonIcon = () => (
  <Icon>
    <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />
  </Icon>
);
export const FitIcon = () => (
  <Icon>
    <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
  </Icon>
);
export const ResetIcon = () => (
  <Icon>
    <path d="M3 12a9 9 0 1 0 3-6.7" />
    <path d="M3 4v5h5" />
  </Icon>
);
export const DownloadIcon = () => (
  <Icon>
    <path d="M12 4v11M7 11l5 5 5-5M5 20h14" />
  </Icon>
);
export const ImportIcon = () => (
  <Icon>
    <path d="M12 15V4M7 8l5-5 5 5M5 14v5h14v-5" />
  </Icon>
);
export const WarningIcon = () => (
  <Icon>
    <path d="M12 4 2.5 20h19L12 4z" />
    <path d="M12 10v4.5M12 17.3v.2" />
  </Icon>
);
export const InfoIcon = () => (
  <Icon width="13" height="13">
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5.5M12 7.6v.2" />
  </Icon>
);
export const NoteIcon = () => (
  <Icon>
    <path d="M6 4.5h9l3.5 3.5V19a.5.5 0 0 1-.5.5H6a.5.5 0 0 1-.5-.5V5a.5.5 0 0 1 .5-.5Z" />
    <path d="M8.5 11h7M8.5 14.5h7" />
  </Icon>
);
export const ChevronIcon = () => (
  <Icon width="12" height="12" strokeWidth="2.4">
    <path d="m6 9 6 6 6-6" />
  </Icon>
);
export const UndoIcon = () => (
  <Icon>
    <path d="M8 5 3.5 9.5 8 14" />
    <path d="M4 9.5h10a6 6 0 0 1 0 12h-3" />
  </Icon>
);
export const RedoIcon = () => (
  <Icon>
    <path d="m16 5 4.5 4.5L16 14" />
    <path d="M20 9.5H10a6 6 0 0 0 0 12h3" />
  </Icon>
);
export const DuplicateIcon = () => (
  <Icon>
    <rect x="8.5" y="8.5" width="12" height="12" rx="2" />
    <path d="M15.5 8.5v-3a2 2 0 0 0-2-2h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3" />
  </Icon>
);
export const ArrayIcon = () => (
  <Icon>
    <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
    <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
    <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
    <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
  </Icon>
);
export const TrashIcon = () => (
  <Icon>
    <path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13M10 11v5.5M14 11v5.5" />
  </Icon>
);
export const GroupIcon = () => (
  <Icon>
    <rect x="3.5" y="3.5" width="10" height="10" rx="1.5" />
    <circle cx="14.5" cy="14.5" r="6" />
  </Icon>
);
export const UngroupIcon = () => (
  <Icon>
    <rect x="3" y="3" width="8" height="8" rx="1.5" />
    <circle cx="16.5" cy="16.5" r="4.5" />
    <path d="M13 7h2M18 7h1.5V8.5M7 13v2M7 18v1.5h1.5" strokeDasharray="0" />
  </Icon>
);
export const AlignIcon = () => (
  <Icon>
    <path d="M4 3v18" />
    <rect x="8" y="5.5" width="12" height="5" rx="1" />
    <rect x="8" y="13.5" width="7" height="5" rx="1" />
  </Icon>
);
/** A ruler, on the slant. */
export const RulerIcon = () => (
  <Icon>
    <path d="M3.5 16.5 16.5 3.5l4 4L7.5 20.5z" />
    <path d="M7 13l2 2M10 10l2 2M13 7l2 2" />
  </Icon>
);

/* The Measure tool's snaps, in the drafting tradition: a square for a point, a triangle for a middle, a diamond for a quadrant. */
export const SnapPointIcon = () => (
  <Icon>
    <path d="M3 21l6-6" />
    <rect x="9" y="5" width="10" height="10" />
  </Icon>
);

export const SnapMiddleIcon = () => (
  <Icon>
    <path d="M3 14h18" />
    <path d="M12 7.5 17 16H7z" />
  </Icon>
);

export const SnapEdgeIcon = () => (
  <Icon>
    <path d="M4 19 20 5" />
    <circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none" />
  </Icon>
);

export const SnapCircleIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="7.5" />
    <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
  </Icon>
);

export const SnapQuadrantIcon = () => (
  <Icon>
    <circle cx="11" cy="12" r="7.5" />
    <path d="M21.5 12 18.5 9l-3 3 3 3z" fill="var(--panel, #fff)" />
  </Icon>
);

export const SnapFaceCenterIcon = () => (
  <Icon>
    <path d="M3 17.5 8 6.5h13l-5 11z" />
    <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
  </Icon>
);

export const SnapFaceIcon = () => (
  <Icon>
    <path d="M3 17.5 8 6.5h13l-5 11z" fill="currentColor" fillOpacity="0.25" />
  </Icon>
);

export const SnapCenterIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="6.5" />
    <path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4" />
    <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
  </Icon>
);

export const MirrorIcon = () => (
  <Icon>
    <path d="M12 3v18" strokeDasharray="2.5 3" />
    <path d="M8.5 7 3 17h5.5V7zM15.5 7 21 17h-5.5V7z" />
  </Icon>
);
export const DropIcon = () => (
  <Icon>
    <path d="M12 3v11M7.5 10l4.5 4.5 4.5-4.5M4 20h16" />
  </Icon>
);
export const EyeIcon = () => (
  <Icon width="14" height="14">
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
    <circle cx="12" cy="12" r="2.8" />
  </Icon>
);
export const EyeOffIcon = () => (
  <Icon width="14" height="14">
    <path d="M4 4l16 16M9.9 6A8.6 8.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.8 3.6M6.2 7.7A16.5 16.5 0 0 0 2.5 12S6 18.5 12 18.5a8.7 8.7 0 0 0 3.7-.8" />
  </Icon>
);
export const LockIcon = () => (
  <Icon width="14" height="14">
    <rect x="5" y="10.5" width="14" height="9.5" rx="2" />
    <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
  </Icon>
);
export const UnlockIcon = () => (
  <Icon width="14" height="14">
    <rect x="5" y="10.5" width="14" height="9.5" rx="2" />
    <path d="M8 10.5V8a4 4 0 0 1 7.5-2" />
  </Icon>
);
export const GhostIcon = ({ small }: { small?: boolean }) => (
  <Icon {...(small ? { width: 14, height: 14 } : {})}>
    <path d="M5 20.5V11a7 7 0 0 1 14 0v9.5l-2.3-2-2.35 2-2.35-2-2.35 2-2.35-2z" />
    <path d="M9.5 11.5h.01M14.5 11.5h.01" strokeWidth="2.6" />
  </Icon>
);
export const UnghostIcon = ({ small }: { small?: boolean }) => (
  <Icon {...(small ? { width: 14, height: 14 } : {})}>
    <path d="M5 20.5V11a7 7 0 0 1 14 0v9.5l-2.3-2-2.35 2-2.35-2-2.35 2-2.35-2z" />
    <path d="M4 4l16 16" />
  </Icon>
);
export const ProjectsIcon = () => (
  <Icon>
    <rect x="4" y="4" width="7" height="7" rx="1.2" />
    <rect x="13" y="4" width="7" height="7" rx="1.2" />
    <rect x="4" y="13" width="7" height="7" rx="1.2" />
    <rect x="13" y="13" width="7" height="7" rx="1.2" />
  </Icon>
);
/** An arrow going down into an open box: save as a custom part. */
export const SaveAsPartIcon = () => (
  <Icon>
    <path d="M12 3v10M8.5 9.5 12 13l3.5-3.5" />
    <path d="M4 13v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5" />
    <path d="M4 14h4.5l1.5 2h4l1.5-2H20" />
  </Icon>
);
/** A box of parts: the custom parts tile in the library. */
export const PartsBinIcon = () => (
  <Icon>
    <path d="M4 9.5 12 5l8 4.5v7L12 21l-8-4.5z" />
    <path d="M4 9.5 12 14l8-4.5M12 14v7" />
    <path d="M8 7.3l8 4.5" />
  </Icon>
);
export const MoreIcon = () => (
  <Icon>
    <circle cx="6" cy="12" r="1.3" fill="currentColor" />
    <circle cx="12" cy="12" r="1.3" fill="currentColor" />
    <circle cx="18" cy="12" r="1.3" fill="currentColor" />
  </Icon>
);
export const MenuIcon = () => (
  <Icon>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Icon>
);
export const CloseIcon = () => (
  <Icon width="14" height="14">
    <path d="M6 6l12 12M18 6 6 18" />
  </Icon>
);
export const PictureIcon = () => (
  <Icon>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <circle cx="9" cy="10" r="1.6" />
    <path d="m21 16-5-5-8 8" />
  </Icon>
);
export const LinkIcon = () => (
  <Icon width="14" height="14">
    <path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1" />
    <path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1" />
  </Icon>
);

/** App mark (the same drawing as the favicon). */
export const Logo = () => <img src="/icon.svg" width="22" height="22" alt="" />;
/** A robot's head: Robot mode. */
export const RobotIcon = () => (
  <Icon>
    <rect x="4.5" y="8" width="15" height="11" rx="2.5" />
    <path d="M12 8V5.5" />
    <circle cx="12" cy="4" r="1.5" />
    <path d="M9 13h.01M15 13h.01" strokeWidth="2.6" />
    <path d="M9.5 16.5h5" />
  </Icon>
);
/** A hinge pin with its axis through it: a joint. */
export const JointIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="3.5" />
    <path d="M12 3v5.5M12 15.5V21" />
    <path d="M5.5 16.5 9 14M18.5 7.5 15 10" />
  </Icon>
);
/** A map pin: pick a point on the plate. */
export const PinIcon = () => (
  <Icon>
    <path d="M12 21s-6-5.5-6-10.5a6 6 0 0 1 12 0C18 15.5 12 21 12 21z" />
    <circle cx="12" cy="10.5" r="2.2" />
  </Icon>
);
/** An eye on a stalk: a sensor. */
export const SensorIcon = () => (
  <Icon>
    <path d="M3 12s3.5-5 9-5 9 5 9 5-3.5 5-9 5-9-5-9-5z" />
    <circle cx="12" cy="12" r="2.5" />
  </Icon>
);
