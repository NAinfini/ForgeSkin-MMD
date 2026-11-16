using System;
using ForgeCore;
using SNetwork;

namespace ForgeWeaponEnergyLab.Native;

/// <summary>Energy Lab's messages on its ForgeCore channel. ForgeCore's handshake compares the message formats and this build's
/// fingerprint (the channel content): a player who differs is refused (an error in both logs, a chat line here) and nothing of the guns
/// travels between the two. ForgeCore stamps every message with the session's world and drops one from another, and tells every player
/// who presents the current world (<see cref="NetChannel.Ready"/>, set by the controller); this class only says what each message means
/// and who may send it.</summary>
internal static class EnergyNetwork
{
    private static NetChannel? _channel;
    // A held beam's or flame's shots: ten a second of presentation only, so they stay off the reliable channel. A lost one is bridged by the stream's own window, a late one refused by its sequence.
    // Only the Arc Chain's shots carry every end of the chain; the others send the shot up to its first end.
    private static NetEvent<ShotVisual> _visual = null!, _streamVisual = null!;
    private static NetEvent<FireVisual> _chainVisual = null!;
    private static NetEvent<FlightEnd> _flightEnd = null!;
    private static uint _nextSequence;

    internal static NetChannel Channel => _channel ?? throw new InvalidOperationException("Energy Lab's network channel is not open.");
    /// <summary>A client's launch of a delayed projectile, to the host.</summary>
    internal static NetEvent<FireCommand> Fire { get; private set; } = null!;
    /// <summary>A client's charge (start, repeat, stop), to the host.</summary>
    internal static NetEvent<ChargePacket> Charge { get; private set; } = null!;
    /// <summary>The host's word on a shooter's charge, to everyone.</summary>
    internal static NetEvent<ChargePacket> ChargeVisual { get; private set; } = null!;
    /// <summary>The gun each player has armed: each player's own row, which ForgeCore also gives a player who joins later and drops with the world.</summary>
    internal static PlayerStateSlot<ArmedGun> Armed { get; private set; } = null!;
    /// <summary>The host presents the current world (on the host: this player does).</summary>
    internal static bool Ready => Channel.HostReady;
    internal static uint NextSequence() { if (++_nextSequence == 0) ++_nextSequence; return _nextSequence; }

    internal static void Register(EnergyController controller)
    {
        if (_channel != null) return;
        var channel = Net.Open(Plugin.Id);
        // Nothing is taken until the world is presented here and on the host. A client's word to the host counts from a player who
        // presents it too; the host's word to the clients only from the host.
        bool Presenting() => channel.HostReady && controller.PresentationReady;
        bool FromClient(ulong sender) => Session.IsHost && Presenting() && channel.PeerReady(sender);
        bool FromHost(ulong sender) => channel.FromHost(sender) && Presenting();
        Fire = channel.Event<FireCommand>("fire", (sender, command) => { if (FromClient(sender)) controller.ReceiveCommand(sender, command); });
        Action<ulong, FireVisual> visual = (sender, shot) =>
        {
            if (FromClient(sender)) controller.ReceiveNativeVisual(sender, shot);
            else if (FromHost(sender)) controller.ReceiveVisual(shot);
        };
        Action<ulong, ShotVisual> shot = (sender, part) => { if ((EnergyMode)part.Mode != EnergyMode.ArcChain) visual(sender, FireVisual.From(part)); };
        _visual = channel.Event("visual", shot);
        _streamVisual = channel.Event("stream-visual", shot, NetDelivery.Lossy);
        _chainVisual = channel.Event("chain-visual", visual);
        Charge = channel.Event<ChargePacket>("charge", (sender, packet) => { if (FromClient(sender)) controller.ReceiveCharge(sender, packet); });
        ChargeVisual = channel.Event<ChargePacket>("charge-visual", (sender, packet) => { if (FromHost(sender)) controller.ReceiveChargeVisual(packet); });
        _flightEnd = channel.Event<FlightEnd>("flight-end", (sender, end) => { if (FromHost(sender)) controller.ReceiveFlightEnd(end); });
        Armed = channel.PlayerState<ArmedGun>("armed");
        Armed.Changed += (player, armed) =>
        {
            if (armed && Presenting() && Armed.TryGet(player, out var gun, out _)) controller.ReceiveArmed(player, gun);
        };
        channel.Refused += Refused;
        _channel = channel;
    }

    /// <summary>The definitions are final: the build fingerprint becomes the channel's content, which every player must share.</summary>
    internal static void SealDefinitions() => Channel.Content = BuildFingerprint.Compute();

    /// <summary>ForgeCore refused a player's copy (and logged why). Players cannot read logs: say in chat (on this machine only) why
    /// energy guns stay off.</summary>
    private static void Refused(ulong lookup, string reason)
    {
        if (SNet.TryGetPlayer(lookup, out var player) && player != null) ForgeUI.UIKit.PostChatNotice(EnergyText.Mismatch(player.NickName));
    }

    private static NetEvent<ShotVisual> EventOf(FireVisual visual)
        => (EnergyMode)visual.Mode is EnergyMode.Beam or EnergyMode.Flame ? _streamVisual : _visual;
    /// <summary>Host: a shot it resolved or accepted, to every other player but its shooter (<paramref name="shooter"/>, 0 for the
    /// host's own and a bot's), who drew it when it fired.</summary>
    internal static void Broadcast(FireVisual visual, ulong shooter = 0)
    {
        if ((EnergyMode)visual.Mode == EnergyMode.ArcChain) _chainVisual.BroadcastExcept(visual, shooter);
        else EventOf(visual).BroadcastExcept(visual.Shot, shooter);
    }
    /// <summary>This machine's own shot: the host tells everyone, a client tells the host, who tells the others.</summary>
    internal static void SendVisual(FireVisual visual)
    {
        if (Session.IsHost) Broadcast(visual);
        else if ((EnergyMode)visual.Mode == EnergyMode.ArcChain) _chainVisual.ToHost(visual);
        else EventOf(visual).ToHost(visual.Shot);
    }
    /// <summary>Host: where a projectile ended, to every other player.</summary>
    internal static void BroadcastFlightEnd(FlightEnd end) { if (Ready && Session.IsHost) _flightEnd.Broadcast(end); }
}
