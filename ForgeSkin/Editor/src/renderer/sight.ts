// The sight group (PLAN §4.15): a lens on the skin's own model in the style of one of the game's sights, its reticle, the
// game's zoom of a sight part, and the aim point (the gun's Sight_Align hold point). The lens is drawn as the material named
// LENS: the chosen style's lens params and reticle pictures go into the open preview under that name, so the reticle panel
// and the 3D view treat it as that game lens.
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Box3, Quaternion, Vector3, type Mesh } from 'three';
import { call, type PreviewMaterial, type Sight, type SightInfo, type SkinDocument, type TextureChannel, type WeaponPreview } from './protocol';
import { useStore } from './store';
import { overridesFor, threeToUnity } from './space';
import { wake } from './viewport/DrawLoop';
import type { Target } from './viewport/ModalTransform';
import { displayOffset, partTarget, viewRefs } from './viewport/refs';

/** The material name of the skin's lens (Format Sight.LensMaterial). */
export const LENS = 'sight:lens';
/** A new pane: 3 by 2 cm, 10 cm in front of the aim point. 对准镜片 puts the aim point 10 cm behind the lens centre. */
const NEW_PANE: [number, number] = [0.03, 0.02];
const EYE_GAP = 0.1;
/** The aim preview's world field of view without a chosen zoom: the median of the game's open sights (ForgeCore gun-hold.json
 *  sight.openLookFov), only a stand-in for the gun's own. */
export const AIM_FALLBACK_FOV = 45;

/** Picking a mesh for the lens in the 3D view, and the aim preview (the 3D view looks through the aim point). */
export const sightView = {
  picking: false,
  aiming: false,
  version: 0,
  subs: new Set<() => void>(),
  set(p: Partial<{ picking: boolean; aiming: boolean }>) {
    Object.assign(sightView, p);
    sightView.version++;
    sightView.subs.forEach((f) => f());
    wake();
  },
};
export function useSightView() {
  useSyncExternalStore(
    (f) => (sightView.subs.add(f), () => sightView.subs.delete(f)),
    () => sightView.version,
  );
  return sightView;
}

/** The pane and the lens meshes the 3D view draws now (viewport/SightLens.tsx). */
export const lensRefs = { pane: null as Mesh | null, meshes: [] as Mesh[] };

let sights: Promise<SightInfo[]> | null = null;
/** The game's sight parts (sights.list), asked once. Null until they are in, and empty when the game cannot be read. */
export function useSights(): SightInfo[] | null {
  const [list, setList] = useState<SightInfo[] | null>(null);
  useEffect(() => {
    let on = true;
    sights ??= call('sights.list', {}).then(
      (r) => r.sights,
      (e) => {
        sights = null;
        useStore.getState().log(`sights.list: ${e instanceof Error ? e.message : String(e)}`);
        return [];
      },
    );
    void sights.then((l) => on && setList(l));
    return () => void (on = false);
  }, []);
  return list;
}

/** Sights a lens can take the style of: a flat holographic lens with a preview. */
export const lensStyles = (list: SightInfo[]) => list.filter((s) => s.lens && s.item);

/** The game's zoom steps: one sight part per distinct pair of fields of view, widest world view first. */
export function zoomSteps(list: SightInfo[]): SightInfo[] {
  const steps = new Map<string, SightInfo>();
  for (const s of list) if ((s.gear > 0 || s.world > 0) && !steps.has(`${s.gear}|${s.world}`)) steps.set(`${s.gear}|${s.world}`, s);
  return [...steps.values()].sort((a, b) => b.world - a.world || b.gear - a.gear);
}

/** One undo step on the skin's sight. */
export function editSight(fn: (s: Sight) => void, key?: string) {
  useStore.getState().edit((d) => {
    fn((d.sight ??= {}));
    tidySight(d);
  }, key);
}

/** Without a lens there is no style and no lens look; an empty sight is none. */
export function tidySight(d: SkinDocument) {
  const s = d.sight;
  if (!s) return;
  if (!s.lens) {
    s.style = null;
    d.materials = (d.materials ?? []).filter((m) => m?.material !== LENS);
  }
  if (!s.lens && s.zoom == null) d.sight = null;
}

type LensLook = { params: PreviewMaterial; textures: Partial<Record<TextureChannel, string>> };
const looks = new Map<number, Promise<LensLook | null>>();

/** The style's lens as its sight's preview has it. */
function lookOf(style: SightInfo): Promise<LensLook | null> {
  let made = looks.get(style.id);
  if (!made) {
    made = call('preview.weapon', { id: style.item! }).then(
      (p) => (p.params[style.lens!] ? { params: p.params[style.lens!], textures: p.textures[style.lens!] ?? {} } : null),
      (e) => {
        looks.delete(style.id);
        useStore.getState().log(`sight style ${style.name}: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      },
    );
    looks.set(style.id, made);
  }
  return made;
}

/** Keeps the open preview's LENS material the chosen style's (none without a lens). */
export function useLensStyle() {
  const style = useStore((s) => (s.doc.sight?.lens ? (s.doc.sight.style ?? null) : null));
  const glb = useStore((s) => s.preview?.glb);
  const list = useSights();
  useEffect(() => {
    let on = true;
    const put = (look: LensLook | null) => {
      const p = useStore.getState().preview;
      if (!on || !p || (p.params[LENS] ?? null) === (look?.params ?? null)) return;
      const params: WeaponPreview['params'] = { ...p.params };
      const textures: WeaponPreview['textures'] = { ...p.textures };
      delete params[LENS];
      delete textures[LENS];
      if (look) {
        params[LENS] = look.params;
        textures[LENS] = look.textures;
      }
      useStore.setState({ preview: { ...p, params, textures } });
    };
    const info = list?.find((s) => s.id === style);
    if (!info?.item || !info.lens) put(null);
    else void lookOf(info).then(put);
    return () => void (on = false);
  }, [style, glb, list]);
}

/** The gizmo on the lens pane: its pose and its size (the pane's X and Y scale) go into the lens. */
export function lensTarget(): Target | null {
  const pane = lensRefs.pane;
  if (!pane) return null;
  return {
    obj: pane,
    commit: (key) => {
      const p = threeToUnity(pane.position, pane.quaternion, pane.scale);
      editSight((s) => {
        if (!s.lens?.size) return;
        s.lens.position = p.position;
        s.lens.rotation = p.rotation;
        s.lens.size = [Math.abs(p.scale[0]), Math.abs(p.scale[1])];
      }, key);
    },
  };
}

/** The gun's aim point (its Sight_Align hold point), as a part layout key. */
export const aimPoint = (preview: WeaponPreview | null) => preview?.points?.find((p) => p.point === 'sight') ?? null;

/** The bore (Unity +Z of the gear) in world space, and the gear's world rotation. */
function bore(): { forward: Vector3; turn: Quaternion } | null {
  const root = viewRefs.root;
  if (!root) return null;
  root.updateMatrixWorld(true);
  const turn = root.getWorldQuaternion(new Quaternion());
  return { forward: new Vector3(0, 0, -1).applyQuaternion(turn), turn };
}

/** A pane facing the aim point along the bore, under the aim point's part root (so moving the aim point leaves it): at `at` (a
 *  world point, where a click on a whole-gun model landed), else 10 cm in front of the aim point. */
export function addPane(style: number | null, at?: Vector3) {
  const s = useStore.getState();
  const point = aimPoint(s.preview);
  const node = point && partTarget(point.part, point.path);
  const parent = point && partTarget(point.part, null);
  const b = bore();
  if (!point || !node || !parent || !b) return false;
  const world = at?.clone() ?? node.getWorldPosition(new Vector3()).addScaledVector(b.forward, EYE_GAP);
  const local = parent.worldToLocal(world);
  const turn = parent.getWorldQuaternion(new Quaternion()).invert().multiply(b.turn);
  const pose = threeToUnity(local, turn, new Vector3(1, 1, 1));
  editSight((sight) => {
    sight.lens = { part: point.part, path: null, size: [...NEW_PANE], position: pose.position, rotation: pose.rotation };
    sight.style ??= style;
  });
  s.select({ kind: 'lens', id: 'lens' });
  return true;
}

/** The lens's centre in world space: the pane's, else the middle of the lens meshes. */
function lensCentre(): Vector3 | null {
  if (lensRefs.pane) return lensRefs.pane.getWorldPosition(new Vector3());
  const box = new Box3();
  lensRefs.meshes.forEach((m) => box.expandByObject(m));
  return box.isEmpty() ? null : box.getCenter(new Vector3());
}

/** 对准镜片: the aim point 10 cm behind the lens centre, looking down the bore. One undo step; false without a lens or aim point. */
export function aimAtLens(): boolean {
  const s = useStore.getState();
  const point = aimPoint(s.preview);
  const obj = point && partTarget(point.part, point.path);
  const vanilla = obj && viewRefs.vanilla.get(obj);
  const centre = lensCentre();
  const b = bore();
  if (!point || !obj?.parent || !vanilla || !centre || !b) return false;
  const local = obj.parent.worldToLocal(centre.addScaledVector(b.forward, -EYE_GAP)).sub(displayOffset(obj));
  const turn = obj.parent.getWorldQuaternion(new Quaternion()).invert().multiply(b.turn);
  const pose = threeToUnity(local, turn, obj.scale);
  s.setPartTransform(point.part, point.path, (t) => void Object.assign(t, overridesFor(vanilla, pose)));
  return true;
}
