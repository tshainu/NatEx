import React from "react";
import { Linking, Platform, Pressable, StyleSheet, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import * as ImagePicker from "expo-image-picker";
import { apiMessage, client, orpc } from "../../../lib/api";
import { dateTime, humanise, money, parseRupeesToCents, since } from "../../../lib/format";
import { dismiss, enqueue, type OutboxEntry } from "../../../lib/outbox";
import { Screen, ScreenHeader, Section } from "../../../components/natex/screen";
import { Button } from "../../../components/natex/button";
import { Card, Empty, Field, Panel } from "../../../components/natex/card";
import { Input } from "../../../components/natex/input";
import { Badge, StatusPill } from "../../../components/natex/pill";
import { SignaturePad } from "../../../components/natex/signature-pad";
import { SyncStrip } from "../../../components/natex/sync-strip";
import { Body, Label, Mono, Small, Title } from "../../../components/natex/text";
import { Space } from "../../../constants/theme";
import { useColors } from "../../../hooks/use-colors";
import {
  stopView,
  useOutbox,
  useReasonCodes,
  useRiderRun,
  type ReasonCode,
  type RunStop,
} from "../../../hooks/use-rider-run";

/**
 * One door. Three modes on one screen — look, deliver, or record a failure —
 * because a rider at a gate should never be two navigations away from either
 * outcome.
 *
 * What the server will insist on is checked here first, so the rider finds out
 * at the door rather than an hour later in a sync verdict:
 *   - the POD method is the merchant's policy (§6), not the rider's choice
 *   - OTP is verified by the server, so it needs signal; signature and photo
 *     are captured on the phone and queue like everything else
 *   - COD must match to the cent (§1) — no "close enough"
 * The record itself always goes through the outbox (§7), online or not.
 */

type Mode = "view" | "deliver" | "fail";
type Relation = "self" | "family" | "neighbour" | "security" | "reception" | "other";
type FreightMethod = "cash" | "bank_transfer" | "qr" | "card";
const RELATIONS: Relation[] = ["self", "family", "neighbour", "security", "reception", "other"];
const FREIGHT_METHODS: FreightMethod[] = ["cash", "bank_transfer", "qr", "card"];

export default function StopScreen() {
  const { awb: raw } = useLocalSearchParams<{ awb: string }>();
  const awb = String(raw).toUpperCase();
  const colors = useColors();
  const runQuery = useRiderRun();
  const box = useOutbox();
  const [mode, setMode] = React.useState<Mode>("view");

  const run = runQuery.data?.run ?? null;
  const stop = run?.items.find((i) => i.awb === awb) ?? null;
  const { view, entry } = stop ? stopView(stop, box.entries) : { view: null, entry: null };
  const dispatched = run?.runsheet.status === "dispatched";
  const actionable = !!stop && view === "todo" && dispatched && stop.status === "OutForDelivery";

  const history = useQuery({
    ...orpc.delivery.history.queryOptions({ input: { awb } }),
    retry: false,
  });

  if (!stop) {
    return (
      <Screen>
        <ScreenHeader title={awb} subtitle="Stop" />
        {runQuery.isPending ? (
          <Small>Loading…</Small>
        ) : (
          <Empty title="This parcel is not on your run" detail="It may have been removed or reassigned by the hub." />
        )}
        <Button title="Back to deliveries" variant="secondary" onPress={() => backToRun()} />
      </Screen>
    );
  }

  if (mode === "deliver") return <DeliverForm stop={stop} onCancel={() => setMode("view")} />;
  if (mode === "fail") return <FailForm stop={stop} onCancel={() => setMode("view")} />;

  const footer = actionable ? (
    <>
      <Button title="Deliver" onPress={() => setMode("deliver")} />
      <Button title="Could not deliver" variant="secondary" onPress={() => setMode("fail")} />
    </>
  ) : (
    <Button title="Back to deliveries" variant="secondary" onPress={() => backToRun()} />
  );

  return (
    <Screen footer={footer} refreshing={runQuery.isRefetching} onRefresh={() => void runQuery.refetch()}>
      <ScreenHeader
        title={stop.consigneeName}
        subtitle={`Stop ${stop.seq} · ${awb}`}
        right={<StatusPill status={stop.status} />}
      />
      <SyncStrip />

      <EntryNotice entry={entry} />

      {!dispatched ? (
        <Panel style={{ borderColor: colors.statusMoving }}>
          <Small>This run is not dispatched yet — the stop opens once the hub sends it out.</Small>
        </Panel>
      ) : view === "todo" && stop.status !== "OutForDelivery" ? (
        <Panel style={{ borderColor: colors.statusMoving }}>
          <Small>
            The server has this parcel as {humanise(stop.status)}, not out for delivery. Pull to refresh;
            if it stays this way ask the hub.
          </Small>
        </Panel>
      ) : null}

      <Card>
        <Field label="Address" value={stop.destAddress} />
        <View style={styles.row}>
          <View style={styles.flex}>
            <Field label="Phone" value={stop.consigneePhone} mono />
          </View>
          <Button
            title="Call"
            variant="secondary"
            onPress={() => void Linking.openURL(`tel:${stop.consigneePhone}`)}
          />
        </View>
        <View style={styles.row}>
          <View style={styles.flex}>
            <Field label="COD · merchant money" value={stop.codAmountCents > 0 ? money(stop.codAmountCents) : "None"} mono />
          </View>
          <View style={styles.flex}>
            <Field
              label="Courier freight · separate"
              value={stop.freightPayer === "recipient" ? `${money(stop.freightAmountCents)} due` : stop.freightPayer === "sender" ? "Sender prepaid" : "None"}
              mono
            />
          </View>
        </View>
        <View style={styles.row}>
          <View style={styles.flex}>
            <Field label="Proof needed" value={podLabel(stop.podPolicy)} />
          </View>
        </View>
        <Field label="Attempt" value={`${stop.attemptNo + 1} of 3`} />
      </Card>

      <Section>
        <Label>History</Label>
        {history.isError ? (
          <Small>History needs signal — not available offline.</Small>
        ) : history.data ? (
          <>
            {history.data.ndr ? (
              <Panel style={{ borderColor: colors.statusMoving }}>
                <Title>Waiting on the merchant</Title>
                <Small>
                  Non-delivery report {humanise(history.data.ndr.state)}. The merchant (or ops, after the SLA) decides
                  whether this goes out again — nothing for you to do here.
                </Small>
              </Panel>
            ) : null}
            {history.data.attempts.length === 0 ? (
              <Small>First attempt.</Small>
            ) : (
              history.data.attempts.map((a) => (
                <Card key={a.id}>
                  <View style={styles.row}>
                    <Mono style={styles.flex}>{`#${a.attemptNo} · ${dateTime(a.ts)}`}</Mono>
                    <Badge tone={a.outcome === "delivered" ? "good" : "warn"}>{humanise(a.outcome)}</Badge>
                  </View>
                  {a.reasonLabel ? <Small>{a.reasonLabel}</Small> : null}
                  {a.riderName ? <Small>{a.riderName}</Small> : null}
                </Card>
              ))
            )}
          </>
        ) : (
          <Small>Loading…</Small>
        )}
      </Section>
    </Screen>
  );
}

/**
 * Always back to the run, explicitly. This screen lives inside the rider tab
 * navigator, whose "back" means "first tab" (Pickups) — the wrong place for a
 * rider who just closed a stop.
 */
function backToRun(): void {
  router.navigate("/(rider)/deliveries");
}

function podLabel(policy: string | null): string {
  if (policy === "otp") return "OTP from consignee";
  if (policy === "photo") return "Doorstep photo";
  return "Signature";
}

/** The phone's own record for this stop, if it has one worth showing. */
function EntryNotice({ entry }: { entry: OutboxEntry | null }) {
  const colors = useColors();
  if (!entry) return null;
  if (entry.state === "pending") {
    return (
      <Panel style={{ borderColor: colors.statusMoving }}>
        <Title>{entry.kind === "delivery.deliver" ? "Delivered — saved on this phone" : "Failed attempt — saved on this phone"}</Title>
        <Small>
          Recorded {since(entry.clientTs)}. It syncs automatically
          {entry.tries > 0 ? ` (tried ${entry.tries}×, no connection yet)` : ""}.
        </Small>
      </Panel>
    );
  }
  if (entry.state === "rejected" || entry.state === "conflict") {
    return (
      <Panel style={{ borderColor: colors.statusWarn }}>
        <Title color={colors.statusWarn}>
          {entry.state === "conflict" ? "Conflict — sent to ops" : "Not accepted by the server"}
        </Title>
        <Body>{entry.error ?? "The server refused this record."}</Body>
        {entry.policy ? <Small>Policy: {humanise(entry.policy)}</Small> : null}
        <Small>
          {entry.state === "conflict"
            ? "It is in the ops exception queue. Nothing was lost; ops decides what happened."
            : "Fix what the message says and record the stop again, or dismiss if ops has handled it."}
        </Small>
        <Button title="Dismiss" variant="ghost" onPress={() => void dismiss(entry.clientOpId)} />
      </Panel>
    );
  }
  const r = entry.result as { ndrId?: string | null; rtoId?: string | null; countedAsAttempt?: boolean; freightReceiptCode?: string | null } | null;
  if (entry.kind === "delivery.deliver" && r?.freightReceiptCode) {
    return (
      <Panel>
        <Title>Courier-freight receipt</Title>
        <Mono>{r.freightReceiptCode}</Mono>
        <Small>Separate from COD. Finance can reprint the customer receipt from the freight register.</Small>
      </Panel>
    );
  }
  if (entry.kind === "delivery.fail" && r) {
    return (
      <Panel>
        <Small>
          Synced.{" "}
          {r.rtoId
            ? "The parcel now returns to the merchant — bring it back to the hub."
            : r.ndrId
              ? "A non-delivery report went to the merchant."
              : ""}
          {r.countedAsAttempt === false ? " This did not count as one of the consignee's three attempts." : ""}
        </Small>
      </Panel>
    );
  }
  return null;
}

// ─────────────────────────────────────────────────────────────── deliver

function DeliverForm({ stop, onCancel }: { stop: RunStop; onCancel: () => void }) {
  const colors = useColors();
  const policy = (stop.podPolicy ?? "signature") as "otp" | "signature" | "photo";
  const [name, setName] = React.useState("");
  const [relation, setRelation] = React.useState<Relation>("self");
  const [cash, setCash] = React.useState("");
  const [freightCash, setFreightCash] = React.useState("");
  const [freightMethod, setFreightMethod] = React.useState<FreightMethod>("cash");
  const [freightReference, setFreightReference] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [signature, setSignature] = React.useState<string | null>(null);
  const [photoRef, setPhotoRef] = React.useState<string | null>(null);
  const [otpCode, setOtpCode] = React.useState("");
  const [otpVerified, setOtpVerified] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);

  const isCod = stop.codAmountCents > 0;
  const cents = parseRupeesToCents(cash);
  const cashOk = !isCod || cents === stop.codAmountCents;
  const freightDue = stop.freightPayer === "recipient" ? stop.freightAmountCents : 0;
  const freightCents = parseRupeesToCents(freightCash);
  const freightValue = freightCents ?? 0;
  const freightOk = freightDue === 0 || (
    freightCents === freightDue &&
    (freightMethod === "cash" || freightReference.trim().length >= 3)
  );

  const sendOtp = useMutation({ mutationFn: () => client.delivery.otpRequest({ awb: stop.awb }) });
  const verifyOtp = useMutation({
    mutationFn: () => client.delivery.otpVerify({ awb: stop.awb, code: otpCode.trim() }),
    onSuccess: (r) => setOtpVerified(r.verified),
  });
  const photo = useMutation({
    mutationFn: async () => {
      const opts: ImagePicker.ImagePickerOptions = { mediaTypes: ["images"], quality: 0.6 };
      if (Platform.OS !== "web") {
        const perm = await ImagePicker.requestCameraPermissionsAsync();
        if (!perm.granted) throw new Error("Camera permission is needed for a doorstep photo.");
      }
      const shot =
        Platform.OS === "web"
          ? await ImagePicker.launchImageLibraryAsync(opts)
          : await ImagePicker.launchCameraAsync(opts);
      if (shot.canceled || !shot.assets[0]) return null;
      const asset = shot.assets[0];
      const contentType = (asset.mimeType ?? "image/jpeg") as "image/jpeg" | "image/png" | "image/webp";
      const slot = await client.delivery.podPhotoUpload({ awb: stop.awb, contentType });
      const blob = await (await fetch(asset.uri)).blob();
      const put = await fetch(slot.uploadUrl, { method: "PUT", body: blob, headers: { "Content-Type": contentType } });
      if (!put.ok) throw new Error(`Photo upload failed (${put.status}). Try again with signal.`);
      return slot.storageRef;
    },
    onSuccess: (ref) => {
      if (ref) setPhotoRef(ref);
    },
  });

  const proofOk =
    policy === "otp" ? otpVerified : policy === "signature" ? !!signature : !!photoRef;
  const nameOk = name.trim().length >= 2;
  const ready = proofOk && nameOk && cashOk && freightOk;
  const collectionLabel = [
    isCod ? `COD ${money(stop.codAmountCents)}` : null,
    freightDue > 0 ? `freight ${money(freightDue)}` : null,
  ].filter(Boolean).join(" + ");

  const save = useMutation({
    // A local write needs no signal. The default ("online") would park this
    // mutation while offline and leave the rider staring at a spinner.
    networkMode: "always",
    mutationFn: () =>
      enqueue("delivery.deliver", stop.awb, {
        receivedByName: name.trim(),
        receivedByRelation: relation,
        method: policy,
        signatureData: policy === "signature" ? signature : null,
        photoUrl: policy === "photo" ? photoRef : null,
        codCollectedCents: isCod ? cents : 0,
        freightCollectedCents: freightDue > 0 ? freightValue : 0,
        freightPaymentMethod: freightDue > 0 ? freightMethod : null,
        freightExternalReference: freightDue > 0 && freightMethod !== "cash" ? freightReference.trim() : null,
        notes: notes.trim() || null,
      }),
    onSuccess: () => backToRun(),
    onError: (e) => setSaveError(e instanceof Error ? e.message : "Could not save."),
  });

  const missing = !nameOk
    ? "Enter who took the parcel"
    : !proofOk
      ? policy === "otp"
        ? "Verify the consignee's OTP"
        : policy === "signature"
          ? "Capture a signature"
          : "Take the doorstep photo"
      : !cashOk
        ? `Cash must be exactly ${money(stop.codAmountCents)}`
        : !freightOk
          ? freightMethod === "cash"
            ? `Freight must be exactly ${money(freightDue)}`
            : "Enter the exact freight amount and payment reference"
          : undefined;

  return (
    <Screen
      footer={
        <>
          <Button
            title={collectionLabel ? `Confirm delivery · ${collectionLabel} collected` : "Confirm delivery"}
            disabled={!ready}
            loading={save.isPending}
            hint={missing}
            onPress={() => save.mutate()}
          />
          <Button title="Back" variant="ghost" onPress={onCancel} disabled={save.isPending} />
        </>
      }
    >
      <ScreenHeader title="Deliver" subtitle={`${stop.awb} · ${stop.consigneeName}`} />

      <Card>
        <Input label="Received by" value={name} onChangeText={setName} placeholder="Full name" autoFocus />
        <Label>Relation to consignee</Label>
        <View style={styles.chips}>
          {RELATIONS.map((r) => (
            <Chip key={r} label={humanise(r)} selected={relation === r} onPress={() => setRelation(r)} />
          ))}
        </View>
      </Card>

      {isCod ? (
        <Card>
          <Label>COD · merchant money</Label>
          <Title>{money(stop.codAmountCents)}</Title>
          <Input
            label="Cash received (Rs.)"
            value={cash}
            onChangeText={setCash}
            keyboardType="decimal-pad"
            code
            placeholder={(stop.codAmountCents / 100).toFixed(2)}
            error={cash && !cashOk ? `Must be exactly ${money(stop.codAmountCents)} — count again.` : undefined}
            hint={cashOk && cash ? "Matches to the cent." : "Count the cash, then type the amount you hold."}
          />
        </Card>
      ) : freightDue === 0 ? (
        <Panel>
          <Small>No COD or recipient freight is due. Do not collect courier charges.</Small>
        </Panel>
      ) : null}

      {freightDue > 0 ? (
        <Card>
          <Label>Courier freight · recipient pays (not COD)</Label>
          <Title>{money(freightDue)}</Title>
          <Input
            label="Freight collected (Rs.)"
            value={freightCash}
            onChangeText={setFreightCash}
            keyboardType="decimal-pad"
            code
            placeholder={(freightDue / 100).toFixed(2)}
            error={freightCash && !freightOk ? `Must equal ${money(freightDue)} and include the required payment reference.` : undefined}
          />
          <Label>Payment method</Label>
          <View style={styles.chips}>
            {FREIGHT_METHODS.map((value) => (
              <Chip key={value} label={humanise(value)} selected={freightMethod === value} onPress={() => setFreightMethod(value)} />
            ))}
          </View>
          {freightMethod !== "cash" ? (
            <Input label="Payment reference" value={freightReference} onChangeText={setFreightReference} placeholder="Bank / QR / card reference" />
          ) : null}
          <Small>Record this separately from COD. A unique courier-freight receipt is created when delivery syncs.</Small>
        </Card>
      ) : null}

      <Card>
        {policy === "otp" ? (
          <>
            <Label>OTP proof</Label>
            <Small>
              A code goes to the consignee by SMS. The server checks it, so this step needs signal.
            </Small>
            {otpVerified ? (
              <Badge tone="good">OTP verified by server</Badge>
            ) : (
              <>
                <Button
                  title={sendOtp.isSuccess ? "Resend code" : "Send code to consignee"}
                  variant="secondary"
                  loading={sendOtp.isPending}
                  onPress={() => sendOtp.mutate()}
                />
                {sendOtp.data ? (
                  <Small>
                    Sent to {sendOtp.data.sentTo} · expires in {sendOtp.data.expiresInMinutes} min
                    {sendOtp.data.devCode ? ` · DEV (no SMS gateway): ${sendOtp.data.devCode}` : ""}
                  </Small>
                ) : null}
                {sendOtp.isError ? (
                  <Small color={colors.statusWarn}>{apiMessage(sendOtp.error, "No signal — OTP cannot be sent offline.")}</Small>
                ) : null}
                <Input
                  label="Code from consignee"
                  value={otpCode}
                  onChangeText={setOtpCode}
                  keyboardType="number-pad"
                  code
                  maxLength={8}
                />
                <Button
                  title="Verify code"
                  variant="secondary"
                  disabled={otpCode.trim().length < 4}
                  loading={verifyOtp.isPending}
                  onPress={() => verifyOtp.mutate()}
                />
                {verifyOtp.isError ? (
                  <Small color={colors.statusWarn}>{apiMessage(verifyOtp.error, "Code not accepted.")}</Small>
                ) : null}
              </>
            )}
          </>
        ) : policy === "signature" ? (
          <SignaturePad onChange={setSignature} />
        ) : (
          <>
            <Label>Doorstep photo</Label>
            <Small>The photo uploads straight away (needs signal); the delivery record itself can sync later.</Small>
            {photoRef ? <Badge tone="good">Photo uploaded</Badge> : null}
            <Button
              title={photoRef ? "Retake photo" : "Take photo"}
              variant="secondary"
              loading={photo.isPending}
              onPress={() => photo.mutate()}
            />
            {photo.isError ? (
              <Small color={colors.statusWarn}>{apiMessage(photo.error, "Photo could not be uploaded.")}</Small>
            ) : null}
          </>
        )}
      </Card>

      <Card>
        <Input label="Notes (optional)" value={notes} onChangeText={setNotes} multiline maxLength={400} />
      </Card>

      {saveError ? <Small color={colors.statusWarn}>{saveError}</Small> : null}
    </Screen>
  );
}

// ─────────────────────────────────────────────────────────────── fail

function FailForm({ stop, onCancel }: { stop: RunStop; onCancel: () => void }) {
  const colors = useColors();
  const reasons = useReasonCodes();
  const [code, setCode] = React.useState<string | null>(null);
  const [notes, setNotes] = React.useState("");
  const [saveError, setSaveError] = React.useState<string | null>(null);

  const list = reasons.data?.reasons ?? [];
  const chosen = list.find((r) => r.code === code) ?? null;
  const groups = groupBy(list);
  const lastAttempt = stop.attemptNo + 1 >= 3;

  const save = useMutation({
    networkMode: "always",
    mutationFn: () =>
      enqueue("delivery.fail", stop.awb, { reasonCode: code, notes: notes.trim() || null }),
    onSuccess: () => backToRun(),
    onError: (e) => setSaveError(e instanceof Error ? e.message : "Could not save."),
  });

  return (
    <Screen
      footer={
        <>
          <Button
            title="Record failed attempt"
            variant="danger"
            disabled={!chosen}
            loading={save.isPending}
            hint={chosen ? undefined : "Choose what stopped the delivery"}
            onPress={() => save.mutate()}
          />
          <Button title="Back" variant="ghost" onPress={onCancel} disabled={save.isPending} />
        </>
      }
    >
      <ScreenHeader title="Could not deliver" subtitle={`${stop.awb} · ${stop.consigneeName}`} />

      {reasons.data?.fromCache ? <Small>Offline — using the reason list saved on this phone.</Small> : null}
      {reasons.isError ? (
        <Panel style={{ borderColor: colors.statusWarn }}>
          <Body color={colors.statusWarn}>Reason codes are not on this phone yet. Get signal once to download them.</Body>
        </Panel>
      ) : null}

      {chosen ? <Consequence reason={chosen} lastAttempt={lastAttempt} /> : null}

      {groups.map(([category, rows]) => (
        <Section key={category}>
          <Label>{humanise(category)}</Label>
          {rows.map((r) => {
            const selected = r.code === code;
            return (
              <Card
                key={r.code}
                accessibilityLabel={r.label}
                onPress={() => setCode(r.code)}
                style={selected ? { borderColor: colors.primary, borderWidth: 2 } : undefined}
              >
                <View style={styles.row}>
                  <Body style={styles.flex}>{r.label}</Body>
                  {selected ? <Badge tone="brand">Selected</Badge> : null}
                </View>
                <View style={styles.chips}>
                  {!r.countsAsAttempt ? <Badge tone="good">No attempt used</Badge> : null}
                  {r.triggersRto ? <Badge tone="bad">Returns to merchant</Badge> : null}
                  {!r.allowsReattempt && !r.triggersRto ? <Badge tone="warn">Needs merchant instruction</Badge> : null}
                </View>
              </Card>
            );
          })}
        </Section>
      ))}

      <Card>
        <Input label="Notes (optional)" value={notes} onChangeText={setNotes} multiline maxLength={400} />
      </Card>
      {saveError ? <Small color={colors.statusWarn}>{saveError}</Small> : null}
    </Screen>
  );
}

function Consequence({ reason, lastAttempt }: { reason: ReasonCode; lastAttempt: boolean }) {
  const colors = useColors();
  const lines: string[] = [];
  if (reason.triggersRto) lines.push("The parcel turns back to the merchant now. Bring it to the hub.");
  else if (reason.countsAsAttempt && lastAttempt)
    lines.push("This is the third attempt — the parcel will be returned to the merchant.");
  else if (!reason.allowsReattempt) lines.push("The merchant has to fix this before it goes out again.");
  else lines.push("The merchant is notified and the parcel can go out again.");
  if (!reason.countsAsAttempt) lines.push("Not the consignee's fault — it does not use one of their three attempts.");
  return (
    <Panel style={{ borderColor: reason.triggersRto || lastAttempt ? colors.statusWarn : colors.border }}>
      {lines.map((l) => (
        <Small key={l}>{l}</Small>
      ))}
    </Panel>
  );
}

function groupBy(rows: ReasonCode[]): [string, ReasonCode[]][] {
  const map = new Map<string, ReasonCode[]>();
  for (const r of rows) map.set(r.category, [...(map.get(r.category) ?? []), r]);
  return [...map.entries()];
}

function Chip({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  const colors = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[
        styles.chip,
        {
          borderColor: selected ? colors.primary : colors.border,
          backgroundColor: selected ? `${colors.primary}1F` : "transparent",
        },
      ]}
    >
      <Label color={selected ? colors.primary : colors.foreground}>{label}</Label>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: "row", alignItems: "center", gap: Space.unit * 1.5 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: Space.unit },
  chip: {
    minHeight: Space.minTouch,
    paddingHorizontal: Space.unit * 2,
    borderWidth: 1,
    borderRadius: Space.radiusPill,
    justifyContent: "center",
  },
});
