import { useEffect } from "react";

/** `(n) Tenaza` in the tab title (ticket 08, decision 04) — `n` is how many cards sit in TE NECESITA, the same count a human glancing at the tab wants to know without the page in focus. */
export function useDocumentTitle(teNecesitaCount: number): void {
  useEffect(() => {
    document.title = teNecesitaCount > 0 ? `(${teNecesitaCount}) Tenaza` : "Tenaza";
  }, [teNecesitaCount]);
}
