import { Suspense, lazy } from "react";
import type { ComponentProps, FC } from "react";

// The canvas, and the Markdown renderer only it uses, are a large part of the app's script, so
// they are fetched the first time a canvas is opened instead of at every start.
const Canvas = lazy(() => import("./CanvasView").then((m) => ({ default: m.CanvasView })));

export const CanvasView: FC<ComponentProps<typeof Canvas>> = (props) => (
  <Suspense fallback={null}>
    <Canvas {...props} />
  </Suspense>
);
