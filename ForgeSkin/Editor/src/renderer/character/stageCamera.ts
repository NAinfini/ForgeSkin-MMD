// How a tab's 3D view frames the figure. Both tabs — 人物 and 舞蹈 — put the camera where this puts it, so the same
// character stands the same size in the same place whichever tab is open.
import { Box3, type Object3D } from 'three';
import type CameraControlsImpl from 'camera-controls';

/** Frames a model whatever its size, its feet clear of the moves bar along the bottom. */
export function frameFigure(controls: CameraControlsImpl | null, scene: Object3D | null): void {
  if (!controls || !scene) return;
  const box = new Box3().setFromObject(scene);
  if (box.isEmpty()) return;
  void controls.fitToBox(box, false, { paddingTop: 0.1, paddingBottom: 0.35 * (box.max.y - box.min.y) });
}