using Player;
using UnityEngine;

namespace ForgeOrdnance.Frames;

/// <summary>The worn suit's hit volume. The game lands an attack on a player only where it reaches one of that player's limb
/// colliders, and the suit is far larger than the person inside it: a shooter's projectile, a blast or a teammate's bullet reaching the
/// shell away from the person's body went through it without a hit. While a suit is worn, every peer gives its pilot one more limb: a
/// capsule from the feet to the helmet top, centred on the pilot, carrying the game's own player limb (<c>Dam_PlayerDamageLimb</c>) that
/// points at the pilot's damage base. A hit on it is the game's own hit on that player (a projectile is applied by the pilot's own
/// peer and reaches the host by the game's packet), so it goes through the one accept path to <see cref="PilotDamage"/> like any
/// other. It takes the layer and trigger flag of the pilot's own limbs, so every query that sees the body sees it the same way, and a
/// blast still counts once per player (the game marks the damage base, not the limb). This peer's own pilot has no limbs; a pilot
/// without limbs takes the layer the other peers' limbs of that player have (<see cref="LocalLayer"/>).</summary>
internal sealed class PilotHull
{
    /// <summary>The helmet top over the suit's eye, metres.</summary>
    private const float HelmetOverEye = 0.3f;
    /// <summary>The capsule's radius as a share of its height: about the shoulders of the shut shell.</summary>
    private const float RadiusPerHeight = 0.25f;

    private GameObject? _node;

    internal void Wear(PlayerAgent agent, float eyeHeight)
    {
        Remove();
        // A teammate's synced body carries the game's limbs; the hull copies one limb's layer and trigger flag. This peer's own player
        // has none at all (the third test round read none under it, inactive children included), so its hull layer is chosen below.
        Collider? body = null;
        foreach (var limb in agent.GetComponentsInChildren<Dam_PlayerDamageLimb>(true))
        {
            body = limb.GetComponent<Collider>();
            if (body != null) break;
        }
        var damage = agent.Damage;
        int layer;
        bool trigger = false;
        var refusal = "";
        if (body != null) { layer = body.gameObject.layer; trigger = body.isTrigger; }
        else if (!LocalLayer(out layer, out refusal)) refusal = "it has no limb collider and its hull layer was refused: " + refusal;
        if (damage == null) refusal = "it has no damage base";
        if (refusal.Length > 0)
        {
            Plugin.Logger.ErrorOnce("frames-hull-unavailable", "Exosuit pilot in slot " + agent.PlayerSlotIndex + ": " + refusal
                + "; hits on the suit's shell outside the pilot's body do not count.");
            return;
        }
        var height = eyeHeight + HelmetOverEye;
        _node = new GameObject("ForgeOrdnance.Frames.Hull") { layer = layer };
        var node = _node.transform;
        node.SetParent(agent.transform, false);
        node.localPosition = new Vector3(0f, height * 0.5f, 0f);
        var capsule = _node.AddComponent<CapsuleCollider>();
        capsule.direction = 1;
        capsule.height = height;
        capsule.radius = height * RadiusPerHeight;
        capsule.isTrigger = trigger;
        var hull = _node.AddComponent<Dam_PlayerDamageLimb>();
        hull.SetBaseDamagable(damage);
        hull.m_damageMultiplier = 1f;
    }

    /// <summary>The hull layer of a pilot without limbs (this peer's own player). The game builds no limbs for the local player (its body is the character
    /// controller), so the hull takes the layer every other peer gives this player's limbs, the synced-player layer, provided an enemy
    /// projectile's ray sees that layer (<c>LayerManager.MASK_ENEMY_PROJECTILE_COLLIDERS</c>, the mask <c>ProjectileBase.CheckCollision</c>
    /// casts with; it then takes the damage receiver on the hit collider's own object, the hull's limb) and the player's own controller
    /// passes through it (the layer pair is ignored, as teammates pass through each other), so the capsule never blocks the pilot.</summary>
    private static bool LocalLayer(out int layer, out string refusal)
    {
        layer = LayerManager.LAYER_PLAYER_SYNCED;
        refusal = "";
        if (layer is < 0 or > 31) refusal = "the synced-player layer is unset";
        else if ((LayerManager.MASK_ENEMY_PROJECTILE_COLLIDERS & (1 << layer)) == 0) refusal = "enemy projectiles do not see the synced-player layer";
        else if (!Physics.GetIgnoreLayerCollision(LayerManager.LAYER_PLAYER_MOVER, layer)) refusal = "the player's controller would collide with the synced-player layer";
        return refusal.Length == 0;
    }

    internal void Remove()
    {
        if (_node != null && !_node.WasCollected) Object.Destroy(_node);
        _node = null;
    }
}
