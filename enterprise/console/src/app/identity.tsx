import { createContext, useContext } from "react";

import type { ConsoleIdentity } from "../api";

export const IdentityContext = createContext<ConsoleIdentity | null>(null);

export function useIdentity(): ConsoleIdentity {
  const identity = useContext(IdentityContext);
  if (!identity) throw new Error("useIdentity 必须在已登录的树内使用");
  return identity;
}
