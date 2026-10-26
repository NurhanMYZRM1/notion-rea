/** Timing marks. Release builds forward only warn+ to the system log, so marks use warn there. */
export const perfMark = (message: string) => (__DEV__ ? console.log : console.warn)(`[perf] ${message}`);
