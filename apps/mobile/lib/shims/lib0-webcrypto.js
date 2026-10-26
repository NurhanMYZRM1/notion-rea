// Native replacement for `lib0/webcrypto`: lib0's react-native entry requires `isomorphic-webcrypto`,
// but Yjs only needs secure random ids, which expo-crypto provides. (The DOM bundle uses the browser entry.)
export { getRandomValues } from "expo-crypto";
export const subtle = globalThis.crypto?.subtle;
