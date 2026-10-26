/** Shared neutral workspace palette; native components and the browser consume the same values. */
export const workspacePalette = {
  light: {
    background: "#ffffff", surface: "#ffffff", sidebar: "#f7f7f5", foreground: "#37352f",
    muted: "#686761", tertiary: "#9b9a97", border: "#e9e9e7", hover: "#efefed", active: "#e8e8e5",
    accent: "#1673c9", accentSolid: "#1673c9", danger: "#b93e39", warning: "#b78103", success: "#448361",
  },
  dark: {
    background: "#191919", surface: "#202020", sidebar: "#202020", foreground: "#d4d4d4",
    muted: "#9b9b9b", tertiary: "#737373", border: "#2f2f2f", hover: "#2c2c2c", active: "#353535",
    accent: "#529cca", accentSolid: "#1673c9", danger: "#ff7369", warning: "#dfab01", success: "#6c9b7d",
  },
} as const;

export const workspaceSpacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const workspaceType = { body: 16, sidebar: 14, titleDesktop: 40, titleMobile: 32 } as const;
export const workspaceRadius = { small: 4, control: 6, dialog: 10 } as const;
