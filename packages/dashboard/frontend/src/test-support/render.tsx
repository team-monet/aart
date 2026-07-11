// renderWithRouter — the shared precondition every page test needs: every
// page (even ones that never call navigate()) reads router context via
// useRouter()/Link, so rendering a page outside RouterProvider throws
// immediately ("useRouter must be used within RouterProvider"). Mirrors
// packages/dashboard/src/test-support/fixtures.ts's role on the backend
// side of this package: shared test scaffolding, not itself a *.test.tsx.
import type { ReactElement } from "react";
import { render } from "@testing-library/react";
import { RouterProvider } from "../router";

export function renderWithRouter(ui: ReactElement) {
  return render(<RouterProvider>{ui}</RouterProvider>);
}
