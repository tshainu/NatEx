import React from "react";
import { StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, router } from "expo-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiMessage, client, orpc } from "../../../lib/api";
import { date, money, normaliseAwb, plural } from "../../../lib/format";
import { Screen, ScreenHeader, Section } from "../../../components/natex/screen";
import { Button } from "../../../components/natex/button";
import { Card, Empty, Field, Panel } from "../../../components/natex/card";
import { Input } from "../../../components/natex/input";
import { BarcodeScanner } from "../../../components/natex/barcode-scanner";
import { Badge, LifecyclePill, StatusPill } from "../../../components/natex/pill";
import { Awb, Body, Label, Mono, Small, Title } from "../../../components/natex/text";
import { Space } from "../../../constants/theme";
import { useColors } from "../../../hooks/use-colors";

/**
 * Collect from one merchant: scan every declared label, then hand over.
 *
 * §5 is explicit that a scan is **presence only** — it does not move custody.
 * Custody moves once, at handover, when every scanned parcel goes to PickedUp
 * through the parcel state machine. So this screen keeps the two acts visibly
 * separate: the top half is scanning, the pinned button is the handover, and it
 * refuses to pretend a short manifest is a complete one.
 */
export default function ManifestScreen() {
  const colors = useColors();
  const queryClient = useQueryClient();
  const { id } = useLocalSearchParams<{ id: string }>();
  const manifestId = String(id);

  const [awb, setAwb] = React.useState("");
  const [feedback, setFeedback] = React.useState<
    { tone: "good" | "warn" | "bad"; text: string } | null
  >(null);
  const [handoverBy, setHandoverBy] = React.useState("");
  const [confirmingHandover, setConfirmingHandover] = React.useState(false);
  const inputRef = React.useRef<React.ComponentRef<typeof Input>>(null);
  const [scannerOpen, setScannerOpen] = React.useState(false);

  const detail = useQuery(orpc.collection.get.queryOptions({ input: { id: manifestId } }));

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: orpc.collection.key() });
  }

  const scan = useMutation({
    mutationFn: (value: string) => client.collection.scan({ manifestId, awb: value }),
    onSuccess: (result) => {
      setFeedback(
        result.alreadyScanned
          ? { tone: "warn", text: `${result.item.awb} was already scanned.` }
          : { tone: "good", text: `${result.item.awb} scanned.` },
      );
      setAwb("");
      invalidate();
      inputRef.current?.focus();
    },
    onError: (error) => {
      setFeedback({ tone: "bad", text: apiMessage(error, "That label was not accepted.") });
    },
  });

  const handover = useMutation({
    mutationFn: () =>
      client.collection.handover({ manifestId, handoverByName: handoverBy.trim() }),
    onSuccess: (result) => {
      invalidate();
      setConfirmingHandover(false);
      const missing = result.missingAwbs.length;
      setFeedback({
        tone: missing > 0 ? "warn" : "good",
        text:
          missing > 0
            ? `${result.movedAwbs.length} picked up; ${plural(missing, "declared label")} never scanned.`
            : `${plural(result.movedAwbs.length, "parcel")} picked up.`,
      });
    },
  });

  const data = detail.data;
  const manifest = data?.manifest;
  const items = data?.items ?? [];
  const scanned = items.filter((i) => i.scannedAt !== null);
  const pending = items.filter((i) => i.scannedAt === null);
  const closed = manifest?.status === "handed_over" || manifest?.status === "cancelled";

  const feedbackColor =
    feedback?.tone === "good"
      ? colors.statusGood
      : feedback?.tone === "warn"
        ? colors.statusMoving
        : colors.statusWarn;

  const footer = closed ? (
    <Button title="Back to pickups" variant="secondary" onPress={() => router.back()} />
  ) : confirmingHandover ? (
    <>
      <Button
        title={`Confirm handover · ${plural(scanned.length, "parcel")}`}
        loading={handover.isPending}
        disabled={handoverBy.trim().length < 2}
        onPress={() => handover.mutate()}
      />
      <Button
        title="Cancel"
        variant="ghost"
        disabled={handover.isPending}
        onPress={() => setConfirmingHandover(false)}
      />
    </>
  ) : (
    <Button
      title="Hand over and take custody"
      disabled={scanned.length === 0}
      hint={
        scanned.length === 0
          ? "Scan at least one label first"
          : pending.length > 0
            ? `${plural(pending.length, "declared label")} not scanned`
            : undefined
      }
      onPress={() => setConfirmingHandover(true)}
    />
  );

  return (
    <Screen
      inTabs
      footer={footer}
      refreshing={detail.isRefetching}
      onRefresh={() => void detail.refetch()}
    >
      <ScreenHeader
        title={data?.merchantName ?? "Pickup"}
        subtitle={manifest ? `Manifest ${manifest.code}` : undefined}
        right={manifest ? <LifecyclePill status={manifest.status} /> : undefined}
      />

      {detail.isError ? (
        <Panel style={{ borderColor: colors.statusWarn }}>
          <Body color={colors.statusWarn}>
            {apiMessage(detail.error, "Could not load this manifest.")}
          </Body>
        </Panel>
      ) : null}

      {confirmingHandover ? (
        <Card>
          <Label>Two-party handover</Label>
          <Body>
            The merchant's representative releases the parcels and you accept them. Their
            name is written into the audit trail beside yours.
          </Body>
          <Input
            label="Released by (merchant staff name)"
            value={handoverBy}
            onChangeText={setHandoverBy}
            placeholder="Full name"
            autoFocus
          />
          {pending.length > 0 ? (
            <Small color={colors.statusMoving}>
              {plural(pending.length, "declared label")} will be left behind
              as a shortfall on this manifest.
            </Small>
          ) : null}
          {handover.isError ? (
            <Small color={colors.statusWarn}>
              {apiMessage(handover.error, "Handover was refused.")}
            </Small>
          ) : null}
        </Card>
      ) : !closed ? (
        <Card>
          <Input
            ref={inputRef}
            label="Scan or type AWB"
            code
            value={awb}
            onChangeText={(value) => {
              setAwb(value);
              setFeedback(null);
            }}
            onSubmitEditing={() => {
              const value = normaliseAwb(awb);
              if (value) scan.mutate(value);
            }}
            returnKeyType="done"
            placeholder="NATEX…"
            editable={!scan.isPending}
          />
          <Button
            title="Scan with camera"
            variant="secondary"
            icon={<Ionicons name="barcode-outline" size={18} color={colors.foreground} />}
            disabled={scan.isPending}
            onPress={() => setScannerOpen(true)}
          />
          <Button
            title="Scan label"
            variant="secondary"
            loading={scan.isPending}
            disabled={normaliseAwb(awb).length === 0}
            onPress={() => scan.mutate(normaliseAwb(awb))}
          />
          {feedback ? (
            <Body color={feedbackColor} style={styles.feedback}>
              {feedback.text}
            </Body>
          ) : null}
        </Card>
      ) : feedback ? (
        <Panel>
          <Body color={feedbackColor}>{feedback.text}</Body>
        </Panel>
      ) : null}

      <Panel>
        <View style={styles.row}>
          <Field label="Scanned" value={`${scanned.length} of ${items.length}`} />
          <Field label="Pickup date" value={date(manifest?.pickupDate)} />
        </View>
        {manifest?.handoverByName ? (
          <Field label="Released by" value={manifest.handoverByName} />
        ) : null}
      </Panel>

      {pending.length > 0 ? (
        <Section>
          <Label>Still to scan · {pending.length}</Label>
          {pending.map((item) => (
            <Card key={item.id}>
              <Awb>{item.awb}</Awb>
              <View style={styles.itemMeta}>
                <Small>{item.consigneeName}</Small>
                <StatusPill status={item.status} />
              </View>
              {(item.codAmountCents ?? 0) > 0 ? (
                <Badge tone="brand">{`COD ${money(item.codAmountCents)}`}</Badge>
              ) : null}
            </Card>
          ))}
        </Section>
      ) : items.length > 0 && !closed ? (
        <Empty title="Every declared label is scanned" detail="Hand over to take custody." />
      ) : null}

      {scanned.length > 0 ? (
        <Section>
          <Label>Scanned · {scanned.length}</Label>
          {scanned.map((item) => (
            <Card key={item.id}>
              <View style={styles.row}>
                <Mono style={styles.flex}>{item.awb}</Mono>
                <StatusPill status={item.status} />
              </View>
              <Small>{item.consigneeName}</Small>
            </Card>
          ))}
        </Section>
      ) : null}

      {manifest?.status === "handed_over" ? (
        <Panel>
          <Title>Handed over</Title>
          <Small>
            Custody is yours. Hand these parcels in at the hub from the Hand in tab.
          </Small>
        </Panel>
      ) : null}
      <BarcodeScanner
        visible={scannerOpen}
        onClose={() => setScannerOpen(false)}
        onScanned={(value) => {
          setScannerOpen(false);
          const awb = normaliseAwb(value);
          if (awb) scan.mutate(awb);
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: "row", alignItems: "center", gap: Space.unit * 1.5 },
  itemMeta: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: Space.unit,
  },
  feedback: { textAlign: "center" },
});
