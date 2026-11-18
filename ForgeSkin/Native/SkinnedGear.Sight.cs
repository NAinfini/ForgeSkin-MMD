using GameData;
using ForgeSkin.Format;
using ForgeVisual;
using UnityEngine;

namespace ForgeSkin.Plugin;

// A skin's sight on its own model (Format.Sight, PLAN §4.15), the game's way. The lens is a copy of a vanilla sight's lens material
// (ForgeCore SightLenses) with the skin's reticle on it, on every copy of the gun (a teammate sees the lens on the sight body; the
// reticle is projected along the aiming eye's view as the game's own lenses are, so only the player who aims sees it). The zoom is
// the local player's aim fields of view, worn through ForgeCore HeldSettings while their first-person gun is in their hands; it is
// never sent.
sealed partial class SkinnedGear
{
    const string ZoomKey = "ForgeSkin.Sight";
    const string LensName = "ForgeSkin " + Sight.LensMaterial;
    uint _lensStyle; // the style whose lens template is still loading (Tick puts the skin on again once it settles); 0: none
    int _zoomItem, _zoomWorld; // the skin's aim fields of view, 0: none
    bool _zoomWorn;

    // The lens look, made before the attachments so an attachment lens is built with it; null without a lens, while the template
    // loads, or when it cannot be had.
    Material? SightLook(Skin skin, SkinDocument doc)
    {
        if (doc.Sight is not { Lens: not null, Style: { } style }) return null;
        var template = SightLenses.Of(style);
        if (template.State == SightLensState.Loading)
        {
            _lensStyle = style;
            ForgeSkinPlugin.Info($"{_label}: sight lens in the style of sight part {style} is loading; the skin goes on again when it is in");
            return null;
        }
        if (template.State == SightLensState.Failed)
        {
            ForgeSkinPlugin.Fail("skin-sight-skipped", $"{_label}: sight part {style} lends no lens ({template.Failure}); the skin's lens is left out");
            return null;
        }
        var look = Own(SightLenses.Copy(template, LensName));
        if (doc.Materials.Find(m => m.Material == Sight.LensMaterial) is { } o) Reticles(skin, look, o);
        return look;
    }

    // A lens on a part node's own model takes every slot of its renderer; a pane is a new flat object under the node. After the
    // part poses, so a node whose model the skin replaced has it.
    void PlaceLens(SightLens lens, Material look)
    {
        if (lens.Attachment != null) return; // built with its attachment (Attach)
        var part = PartObject(lens.Part!);
        var node = part == null ? null : lens.Path == null ? part.transform : part.transform.Find(lens.Path);
        if (node == null)
        {
            ForgeSkinPlugin.Fail("skin-sight-skipped", $"{_label}: sight lens: no node {lens.Part}/{lens.Path ?? "."}; the skin's lens is left out");
            return;
        }
        if (lens.Size is { } size)
        {
            var p = lens.Position ?? new float[3];
            var r = lens.Rotation ?? new float[3];
            var pane = SightLenses.Pane(node, new Vector3(p[0], p[1], p[2]), Quaternion.Euler(r[0], r[1], r[2]), new Vector2(size[0], size[1]), look, LensName);
            var root = Own(pane.gameObject);
            _roots.Add((root, "sight lens", look));
            _swaps.Add((pane, null, pane.sharedMaterials));
            if (_icon) ForgeUI.GearIcons.Unframed(root);
            ForgeSkinPlugin.Info($"{_label}: sight lens pane {size[0]} x {size[1]} m under {lens.Part}/{lens.Path ?? "."}");
            return;
        }
        var renderer = node.GetComponent<Renderer>();
        if (renderer == null || MeshOf(renderer) == null)
        {
            ForgeSkinPlugin.Fail("skin-sight-skipped", $"{_label}: sight lens: {lens.Part}/{lens.Path ?? "."} has no model of its own; the skin's lens is left out");
            return;
        }
        int at = _swaps.FindIndex(s => s.Renderer == renderer);
        var original = at >= 0 ? _swaps[at].Original : renderer.sharedMaterials;
        var mine = at >= 0 ? _swaps[at].Mine : renderer.sharedMaterials;
        for (int i = 0; i < mine.Length; i++)
        {
            // Off the renderer, the game's material is kept from the unused-asset sweep until the revert puts it back (ApplyMaterials).
            if (original != null && original[i] == mine[i] && original[i] != null && (original[i].hideFlags & HideFlags.DontUnloadUnusedAsset) == 0)
                _held.Add(ForgeCore.Assets.Keep(original[i]));
            mine[i] = look;
        }
        renderer.sharedMaterials = mine;
        if (at < 0) _swaps.Add((renderer, original, mine));
        ForgeSkinPlugin.Info($"{_label}: sight lens on {lens.Part}/{lens.Path ?? "."} ({mine.Length} slots)");
    }

    // The zoom's aim fields of view from the game's sight part; worn only by the local player's first-person gun.
    void SightZoom(SkinDocument doc)
    {
        _zoomItem = _zoomWorld = 0;
        if (doc.Sight?.Zoom is not { } zoom || _item == null || _holder == null || _icon || Remote || !_item.m_isFirstPerson) return;
        var properties = GameDataBlockBase<GearSightPartDataBlock>.GetBlock(zoom)?.SightProperties;
        if (properties == null || properties.GearFovZoom <= 0 && properties.WorldFovZoom <= 0)
        {
            ForgeSkinPlugin.Fail("skin-sight-skipped", $"{_label}: sight part {zoom} {(properties == null ? "is not in the game" : "has no zoom of its own")}; the gun keeps its own zoom");
            return;
        }
        _zoomItem = Math.Max(0, (int)properties.GearFovZoom);
        _zoomWorld = Math.Max(0, (int)properties.WorldFovZoom);
        ForgeSkinPlugin.Info($"{_label}: aim zoom of sight part {zoom}: item {_zoomItem}, world {_zoomWorld}");
        if (_itemPointer == _wielded) WearZoom();
    }

    // Wield: the gun in the local player's hands aims with the skin's zoom; unwield and revert give it the game's blocks back.
    void WearZoom()
    {
        if (_zoomItem == 0 && _zoomWorld == 0 || _item == null) return;
        HeldSettings.Wear(_item, ZoomKey, null, _zoomItem, _zoomWorld);
        _zoomWorn = true;
    }

    void TakeOffZoom()
    {
        if (!_zoomWorn) return;
        _zoomWorn = false;
        if (_item != null && !_item.WasCollected) HeldSettings.Restore(_item);
    }

    // Once per tick: gear whose lens template was loading is put on again once it has settled.
    static void LensesSettled(float now)
    {
        foreach (var gear in Live)
            if (gear._lensStyle != 0 && SightLenses.Of(gear._lensStyle).State != SightLensState.Loading) gear.Refresh(now);
    }
}
