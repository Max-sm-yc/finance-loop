import type { ReactNode } from 'react';

export type IconName =
  | 'overview' | 'sales' | 'cash' | 'inventory' | 'analytics' | 'review'
  | 'receipt' | 'activity' | 'settings' | 'signOut' | 'refresh' | 'sync'
  | 'plus' | 'arrowRight' | 'trash' | 'close' | 'more' | 'file' | 'upload'
  | 'copy' | 'check' | 'reject' | 'external' | 'edit' | 'archive' | 'search' | 'download';

const shapes: Record<IconName, ReactNode> = {
  overview: <><rect x="3.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.5" /></>,
  sales: <><path d="M4 19.5h16" /><path d="M6.5 16V11M12 16V6.5M17.5 16v-8" /></>,
  cash: <><rect x="3" y="6" width="18" height="14" rx="2" /><path d="M3 10h18M7 6V4.5A1.5 1.5 0 0 1 8.5 3H19" /><path d="M15.5 14h2" /></>,
  inventory: <><path d="m12 3 8.5 4.5v9L12 21l-8.5-4.5v-9L12 3Z" /><path d="m3.8 7.7 8.2 4.5 8.2-4.5M12 12.2V21" /></>,
  analytics: <><path d="M4 19.5h16" /><path d="m5.5 15 4-4 3 2 5.5-7" /><path d="M18 6h-3M18 6v3" /></>,
  review: <><path d="M9 5.5h11M9 12h11M9 18.5h11" /><path d="m3.5 5.5 1.2 1.2L7 4.4M3.5 12l1.2 1.2L7 10.9M3.5 18.5l1.2 1.2L7 17.4" /></>,
  receipt: <><path d="M6 3.5h12v17l-3-2-3 2-3-2-3 2v-17Z" /><path d="M9 8h6M9 12h6M9 16h3" /></>,
  activity: <><path d="M3 12h4l2.5-6 4.5 12 2.5-6H21" /></>,
  settings: <><path d="M4 7h9M17 7h3M4 17h3M11 17h9" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" /></>,
  signOut: <><path d="M10 4H5.5A1.5 1.5 0 0 0 4 5.5v13A1.5 1.5 0 0 0 5.5 20H10" /><path d="M14 8l4 4-4 4M8 12h10" /></>,
  refresh: <><path d="M20 7v5h-5" /><path d="M19 12a7 7 0 1 1-2-4.9L20 12" /></>,
  sync: <><path d="M20 7v5h-5" /><path d="M19 12a7 7 0 1 1-2-4.9L20 12" /></>,
  plus: <><path d="M12 5v14M5 12h14" /></>,
  arrowRight: <><path d="M4 12h15M13 6l6 6-6 6" /></>,
  trash: <><path d="M4 7h16M10 11v6M14 11v6" /><path d="m6 7 1 13h10l1-13M9 7V4h6v3" /></>,
  close: <><path d="m6 6 12 12M18 6 6 18" /></>,
  more: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
  file: <><path d="M6 3.5h8l4 4V20H6z" /><path d="M14 3.5V8h4M9 12h6M9 16h6" /></>,
  upload: <><path d="M12 16V4M7 9l5-5 5 5" /><path d="M4 15.5v4h16v-4" /></>,
  copy: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8" /></>,
  check: <><path d="m5 12.5 4.5 4.5L19 7" /></>,
  reject: <><circle cx="12" cy="12" r="8.5" /><path d="m9 9 6 6m0-6-6 6" /></>,
  external: <><path d="M13 5h6v6M19 5l-9 9" /><path d="M18 13v5.5a1.5 1.5 0 0 1-1.5 1.5h-12A1.5 1.5 0 0 1 3 18.5v-12A1.5 1.5 0 0 1 4.5 5H10" /></>,
  edit: <><path d="m4 16.5-.8 4.3 4.3-.8L19 8.5 15.5 5 4 16.5Z" /><path d="m13.5 7 3.5 3.5" /></>,
  archive: <><path d="M4 7h16v14H4zM3 3h18v4H3z" /><path d="M9 11h6" /></>,
  search: <><circle cx="10.8" cy="10.8" r="6.8" /><path d="m16 16 4.5 4.5" /></>,
  download: <><path d="M12 4v12M7 11l5 5 5-5" /><path d="M4 19.5h16" /></>,
};

export default function UiIcon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{shapes[name]}</svg>;
}
