import {
  ChevronDown,
  ChevronRight,
  File,
  FolderTree,
  Home,
  MoreHorizontal,
  Plus,
  Search,
  Settings,
  Star,
  Table2,
  Trash2,
  ZoomIn,
  ZoomOut,
  Focus,
  ListTree,
  ArrowLeft,
  X,
  type LucideIcon,
} from "lucide-react-native";
import { colors } from "@/lib/theme";
export const icons = {
  chevronDown: ChevronDown,
  chevronRight: ChevronRight,
  page: File,
  graph: FolderTree,
  home: Home,
  more: MoreHorizontal,
  plus: Plus,
  search: Search,
  settings: Settings,
  star: Star,
  database: Table2,
  trash: Trash2,
  zoomIn: ZoomIn,
  zoomOut: ZoomOut,
  fit: Focus,
  tree: ListTree,
  back: ArrowLeft,
  close: X,
};
export function Icon({
  name,
  size = 20,
  color,
  selected,
}: {
  name: keyof typeof icons;
  size?: number;
  color?: string;
  selected?: boolean;
}) {
  const Component: LucideIcon = icons[name];
  return (
    <Component
      size={size}
      color={color ?? (colors.secondaryLabel as string)}
      strokeWidth={1.6}
      fill={selected ? (colors.secondaryLabel as string) : "none"}
    />
  );
}
