// The sight's lens in the 3D view (sight.ts): a pane under its node, or the node's own model (or an attachment's, Attachments.tsx)
// drawn as the LENS material, which the style's lens paints (weaponScene showReticle); 从模型里选 picks the mesh with a click; and
// the aim preview, which looks through the gun's aim point at the zoom's world field of view.
import { PerspectiveCamera } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useRef } from 'react';
import { DoubleSide, EdgesGeometry, LineBasicMaterial, LineSegments, Mesh, PlaneGeometry, type Material, type Object3D, type PerspectiveCamera as Camera } from 'three';
import { unityToThree } from '../space';
import { useStore } from '../store';
import { addPane, AIM_FALLBACK_FOV, aimPoint, editSight, LENS, lensRefs, lensStyles, sightView, useLensStyle, useSights, useSightView } from '../sight';
import { wholeGunOf } from '../gunSwap';
import { showTab } from '../ui/InspectorTabs';
import { ATTACHMENT_EVENT, hitsAt, ownMeshes, partTarget, pickAt, useSceneVersion, viewRefs } from './refs';

const PANE = new PlaneGeometry(1, 1);
const EDGE = new EdgesGeometry(PANE);

/** The meshes a lens on `node` draws on: its own model, or the imported model that replaces it (PartMeshes). */
function lensMeshes(node: Object3D): Mesh[] {
  const out = ownMeshes(node).filter((m) => (m.material as Material).visible !== false);
  for (const c of node.children) if (c.userData.sfReplacement) c.traverse((o) => void ((o as Mesh).isMesh && out.push(o as Mesh)));
  return out;
}

/** The lens as the plugin builds it. `tools`: the pane's outline and mesh picking (the 3D view, not a card picture). */
export function SightLens({ tools }: { tools: boolean }) {
  useLensStyle();
  const lens = useStore((s) => s.doc.sight?.lens ?? null);
  const selected = useStore((s) => s.selection?.kind === 'lens');
  const version = useSceneVersion();
  const pane = !!lens?.size;

  // The pane: made once per node, posed from the document on every edit (the gizmo moves the same object).
  useEffect(() => {
    const node = pane && lens?.part ? partTarget(lens.part, lens.path) : null;
    const mat = viewRefs.materials?.get(LENS);
    if (!node || !mat) return;
    mat.side = DoubleSide;
    const mesh = new Mesh(PANE, mat);
    mesh.userData.sfLens = true;
    const edge = new LineSegments(EDGE, new LineBasicMaterial({ color: 0x6dff8f, transparent: true, depthTest: false }));
    edge.visible = tools;
    mesh.add(edge);
    node.add(mesh);
    lensRefs.pane = mesh;
    window.dispatchEvent(new Event(ATTACHMENT_EVENT)); // the gizmo looks for its target again
    return () => {
      node.remove(mesh);
      (edge.material as Material).dispose();
      if (lensRefs.pane === mesh) lensRefs.pane = null;
    };
  }, [pane, lens?.part, lens?.path, version, tools]);
  useEffect(() => {
    const mesh = lensRefs.pane;
    if (!mesh || !lens?.size) return;
    const r = unityToThree({
      position: [...(lens.position ?? [0, 0, 0])] as [number, number, number],
      rotation: [...(lens.rotation ?? [0, 0, 0])] as [number, number, number],
      scale: [lens.size[0], lens.size[1], 1],
    });
    mesh.position.copy(r.position);
    mesh.quaternion.copy(r.quaternion);
    mesh.scale.copy(r.scale);
    const edge = mesh.children[0] as LineSegments;
    (edge.material as LineBasicMaterial).opacity = selected ? 1 : 0.45;
  }, [lens, selected, version, pane]);

  // A lens on a node's own model: those meshes show the lens; an imported replacement that loads later is caught each frame.
  const swapped = useRef(new Map<Mesh, Material | Material[]>());
  useEffect(() => {
    const before = swapped.current;
    return () => {
      before.forEach((m, mesh) => void (mesh.material = m));
      before.clear();
      lensRefs.meshes = [];
    };
  }, [pane, lens?.part, lens?.path, lens?.attachment, version]);
  useFrame(() => {
    const node = !pane && lens?.part ? partTarget(lens.part, lens.path) : null;
    const attached = lens?.attachment ? viewRefs.attachments.get(lens.attachment) : null;
    const mat = viewRefs.materials?.get(LENS);
    if (!mat) return;
    const meshes: Mesh[] = node ? lensMeshes(node) : [];
    attached?.traverse((o) => void ((o as Mesh).isMesh && meshes.push(o as Mesh)));
    lensRefs.meshes = meshes;
    if (!node) return; // an attachment's model takes the lens where it is built (Attachments.tsx)
    for (const mesh of meshes)
      if (mesh.material !== mat) {
        if (!swapped.current.has(mesh)) swapped.current.set(mesh, mesh.material);
        mesh.material = mat;
      }
  });

  // 从模型里选: the next click on a mesh makes it the lens; a click on the pane selects it for the gizmo.
  const gl = useThree((s) => s.gl);
  const list = useSights();
  useEffect(() => {
    if (!tools) return;
    const el = gl.domElement;
    const click = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const s = useStore.getState();
      if (sightView.picking) {
        const hit = pickAt(el, e.clientX, e.clientY);
        if (!hit) return;
        e.stopImmediatePropagation();
        sightView.set({ picking: false });
        const style = s.doc.sight?.style ?? (list ? (lensStyles(list)[0]?.id ?? null) : null);
        // A whole-gun model is one mesh, never a lens itself: the lens is a pane where the click landed on it.
        if (hit.pick.kind === 'attachment' && hit.pick.id === wholeGunOf(s.doc)?.attachment) addPane(style, hit.hit.point);
        else if (hit.pick.kind === 'attachment') editSight((sight) => void ((sight.lens = { attachment: hit.pick.id }), (sight.style ??= style)));
        else
          for (let o: Object3D | null = hit.hit.object; o; o = o.parent) {
            const key = viewRefs.transformKey.get(o);
            if (!key) continue;
            editSight((sight) => void ((sight.lens = { part: key.part, path: key.path }), (sight.style ??= style)));
            break;
          }
        showTab('skin', 'sight');
        return;
      }
      if (lensRefs.pane && hitsAt(el, e.clientX, e.clientY, [lensRefs.pane]).length) {
        e.stopImmediatePropagation();
        s.select({ kind: 'lens', id: 'lens' });
        showTab('skin', 'sight');
      }
    };
    el.addEventListener('click', click, { capture: true });
    return () => el.removeEventListener('click', click, { capture: true });
  }, [gl, tools, list]);
  return null;
}

/** 开镜预览: while on, the 3D view looks from the aim point down its own forward (the game lines the camera up with it) at the
 *  zoom's world field of view, or a stand-in when no zoom is chosen. */
export function AimCamera() {
  const view = useSightView();
  const zoom = useStore((s) => s.doc.sight?.zoom ?? null);
  const point = useStore((s) => aimPoint(s.preview));
  const list = useSights();
  const fov = list?.find((s) => s.id === zoom)?.world || AIM_FALLBACK_FOV;
  const cam = useRef<Camera>(null);
  useFrame(() => {
    const node = point && partTarget(point.part, point.path);
    if (!view.aiming || !node || !cam.current) return;
    node.updateWorldMatrix(true, false);
    node.matrixWorld.decompose(cam.current.position, cam.current.quaternion, cam.current.scale);
    cam.current.scale.set(1, 1, 1);
  });
  // Leaving the preview when there is nothing to look through.
  useEffect(() => {
    if (view.aiming && !point) sightView.set({ aiming: false });
  }, [view.aiming, point]);
  return view.aiming && point ? <PerspectiveCamera ref={cam} makeDefault fov={fov} near={0.002} far={50} /> : null;
}
