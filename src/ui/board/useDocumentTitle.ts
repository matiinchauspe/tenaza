import { useEffect } from "react";

/** The TE NECESITA count in the tab title — visible to a human without the page in focus. */
export function useDocumentTitle(teNecesitaCount: number): void {
  useEffect(() => {
    document.title = teNecesitaCount > 0 ? `(${teNecesitaCount}) Tenaza` : "Tenaza";
  }, [teNecesitaCount]);
}
