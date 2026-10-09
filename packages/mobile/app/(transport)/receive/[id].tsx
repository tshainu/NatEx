import React from "react";
import { StyleSheet, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiMessage, client, orpc } from "../../../lib/api";
import { humanise, normaliseAwb, plural } from "../../../lib/format";
import { Screen, ScreenHeader, Section } from "../../../components/natex/screen";
import { Button } from "../../../components/natex/button";
import { Card, Empty, Field, Panel } from "../../../components/natex/card";
import { Input } from "../../../components/natex/input";
import { Badge, LifecyclePill } from "../../../components/natex/pill";
import { Body, Label, Mono, Small, Title } from "../../../components/natex/text";
import { Space } from "../../../constants/theme";
import { useColors } from "../../../hooks/use-colors";
import { invalidAwbPulse } from "../../../lib/feedback";

type Step = "scan" | "confirm" | "done";

/**
 * Two-party hub receipt (§7, §10 M2) — the most consequential screen in the app.
 *
 * Party one is what the origin hub committed to when it sealed the bag: a seal
 * number and a manifest. Party two is what is actually on the dock: the seal in
 * the clerk's hand and every label they physically scan. This screen collects
 * the second without ever showing the first as a checklist to tick — the
 * expected AWBs stay hidden behind a deliberate tap, because a clerk reading
 * labels off a screen and confirming them is not a scan, it is a formality, and
 * that is exactly how a missing parcel gets signed for.
 *
 * The response is then shown in full and unsoftened. Missing, unexpected and
 * seal-mismatch are not errors to retry past; they are findings, already written
 * to the exception queue by the server, and this screen says so plainly. There
 * is no "confirm anyway" that makes a variance disappear.
 */
export default function ReceiveScreen() {
  const colors = useColors();
  const queryClient = useQueryClient();
  const { id } = useLocalSearchParams<{ id: string }>();
  const bagId = String(id);

  const [step, setStep] = React.useState<Step>("scan");
  const [awb, setAwb] = React.useState("");
  const [queue, setQueue] = React.useState<string[]>([]);
  const [seal, setSeal] = React.useState("");
  const [releasedBy, setReleasedBy] = React.useState("");
  const [receivedBy, setReceivedBy] = React.useState("");
  const [revealExpected, setRevealExpected] = React.useState(false);
  const inputRef = React.useRef<React.ComponentRef<typeof Input>>(null);

  const detail = useQuery(orpc.transport.bagGet.queryOptions({ input: { bagId } }));

  const receive = useMutation({
    mutationFn: () =>
      client.transport.bagReceive({
        bagId,
        scannedAwbs: queue,
        sealNumber: seal.trim() || null,
        releasedByName: releasedBy.trim(),
        receivedByName: receivedBy.trim() || null,
      }),
    onSuccess: (result) => {
      if (result.unexpected.length > 0) invalidAwbPulse();
      void queryClient.invalidateQueries({ queryKey: orpc.transport.key() });
      setStep("done");
    },
  });

  const data = detail.data;
  const bag = data?.bag;
  const expected = (data?.items ?? [])
    .filter((item) => item.removedAt === null)
    .map((item) => item.awb);
  const result = receive.data;

  function add() {
    const value = normaliseAwb(awb);
    if (!value) return;
    setQueue((current) => (current.includes(value) ? current : [value, ...current]));
    setAwb("");
    inputRef.current?.focus();
  }

  // Live, scan-side-only arithmetic: how many of this burst the manifest knows
  // about. Shown as a count, never as a list of what is still outstanding.
  const expectedSet = new Set(expected);
  const onManifest = queue.filter((value) => expectedSet.has(value)).length;
  const offManifest = queue.length - onManifest;

  let footer: React.ReactNode = null;
  if (step === "done") {
    footer = (
      <>
        <Button
          title="Back to inbound"
          onPress={() => router.replace("/(transport)/inbound")}
        />
        <Button
          title="Open bag record"
          variant="ghost"
          onPress={() => router.replace(`/(transport)/bag/${bagId}`)}
        />
      </>
    );
  } else if (step === "confirm") {
    const ready = releasedBy.trim().length >= 2;
    footer = (
      <>
        <Button
          title={`Receive ${plural(queue.length, "parcel")}`}
          loading={receive.isPending}
          disabled={!ready}
          hint={ready ? undefined : "Name the person releasing the bag first"}
          onPress={() => receive.mutate()}
        />
        <Button title="Back to scanning" variant="ghost" onPress={() => setStep("scan")} />
      </>
    );
  } else if (data?.canReceive === false) {
    footer = <Button title="Back" variant="secondary" onPress={() => router.back()} />;
  } else {
    footer = (
      <Button
        title={queue.length === 0 ? "Receive with nothing scanned" : "Continue to receipt"}
        variant={queue.length === 0 ? "danger" : "primary"}
        hint={
          queue.length === 0
            ? `All ${plural(expected.length, "parcel")} would be recorded missing`
            : undefined
        }
        onPress={() => setStep("confirm")}
      />
    );
  }

  return (
    <Screen
      inTabs
      footer={footer}
      refreshing={detail.isRefetching}
      onRefresh={() => void detail.refetch()}
    >
      <ScreenHeader
        title={step === "done" ? "Receipt recorded" : "Receive bag"}
        subtitle={data ? `${bag?.code} · ${data.originHubName} → ${data.destHubName}` : undefined}
        right={bag ? <LifecyclePill status={bag.status} /> : undefined}
      />

      {detail.isError ? (
        <Panel style={{ borderColor: colors.statusWarn }}>
          <Body color={colors.statusWarn}>
            {apiMessage(detail.error, "Could not load this bag.")}
          </Body>
        </Panel>
      ) : null}

      {data?.canReceive === false && step !== "done" ? (
        <Panel style={{ borderColor: colors.statusWarn }}>
          <Body color={colors.statusWarn}>This bag cannot be received here.</Body>
          <Small>
            Only the destination hub receives a bag, and only while it is in transit. This
            one is {bag?.status?.replace("_", " ") ?? "unavailable"}.
          </Small>
        </Panel>
      ) : null}

      {/* ------------------------------------------------------------ result */}
      {step === "done" && result ? (
        <>
          <Panel
            style={{
              borderColor:
                result.exceptionsRaised > 0 ? colors.statusWarn : colors.statusGood,
            }}
          >
            <Title color={result.exceptionsRaised > 0 ? colors.statusWarn : colors.statusGood}>
              {result.exceptionsRaised > 0
                ? `${plural(result.exceptionsRaised, "exception")} raised`
                : "Clean receipt"}
            </Title>
            <Small>
              {result.exceptionsRaised > 0
                ? "The variance below is on the Ops exception queue. It stays open until Ops closes it — nothing here clears it."
                : "The seal matched and every manifested parcel was scanned."}
            </Small>
          </Panel>

          <Panel>
            <View style={styles.row}>
              <Field label="Received" value={String(result.received.length)} />
              <Field label="Duplicates" value={String(result.duplicates.length)} />
            </View>
            <View style={styles.row}>
              <Field label="Missing" value={String(result.missing.length)} />
              <Field label="Unexpected" value={String(result.unexpected.length)} />
            </View>
            <Field label="Seal" value={result.sealMatched ? "matched" : "DID NOT MATCH"} mono />
          </Panel>

          {!result.sealMatched ? (
            <Panel style={{ borderColor: colors.statusWarn }}>
              <Label>Seal mismatch</Label>
              <Body color={colors.statusWarn}>
                The seal presented here is not the seal the origin hub recorded.
              </Body>
              <Small>
                Treat the bag as tampered with until Ops says otherwise. Do not re-seal it
                and do not move the parcels on.
              </Small>
            </Panel>
          ) : null}

          {result.missing.length > 0 ? (
            <Section>
              <Label>Missing · {result.missing.length}</Label>
              <Small color={colors.statusWarn}>
                On the manifest, never scanned here. Each one is a possible loss.
              </Small>
              {result.missing.map((line) => (
                <Card key={line.awb}>
                  <Mono color={colors.statusWarn}>{line.awb}</Mono>
                  <Small>{line.reason}</Small>
                </Card>
              ))}
            </Section>
          ) : null}

          {result.unexpected.length > 0 ? (
            <Section>
              <Label>Unexpected · {result.unexpected.length}</Label>
              <Small>Scanned here, not on this bag&apos;s manifest.</Small>
              {result.unexpected.map((line) => (
                <Card key={line.awb}>
                  <Mono>{line.awb}</Mono>
                  <Small>{line.reason}</Small>
                </Card>
              ))}
            </Section>
          ) : null}

          <Section>
            <Label>Received · {result.received.length}</Label>
            {result.received.length === 0 ? (
              <Empty title="Nothing was received into this hub." />
            ) : (
              result.received.map((line) => (
                <Card key={line.awb}>
                  <View style={styles.row}>
                    <Mono style={styles.flex}>{line.awb}</Mono>
                    <Badge tone="good">{line.status ? humanise(line.status) : "received"}</Badge>
                  </View>
                </Card>
              ))
            )}
          </Section>
        </>
      ) : null}

      {/* ----------------------------------------------------------- confirm */}
      {step === "confirm" ? (
        <>
          <Panel>
            <Label>Both parties, named</Label>
            <Small>
              §7 requires a named person on each side of the handover. These names go into
              the custody chain and cannot be edited afterwards.
            </Small>
          </Panel>

          <Card>
            <Input
              label="Seal number on the bag in front of you"
              code
              value={seal}
              onChangeText={setSeal}
              placeholder="SL-000000"
              hint="Read it off the physical seal. Leave blank only if the bag arrived with no seal — that is itself an exception."
            />
            <Input
              label="Released by (driver or origin clerk)"
              value={releasedBy}
              onChangeText={setReleasedBy}
              placeholder="Full name"
            />
            <Input
              label="Received by (you, if not your own account)"
              value={receivedBy}
              onChangeText={setReceivedBy}
              placeholder="Leave blank to record your own name"
            />
          </Card>

          <Panel>
            <View style={styles.row}>
              <Field label="Scanned" value={String(queue.length)} />
              <Field label="On manifest" value={String(expected.length)} />
            </View>
            {queue.length !== expected.length || offManifest > 0 ? (
              <Small color={colors.statusWarn}>
                The counts do not agree. Submitting records the difference as an exception —
                that is the correct thing to do. Go back and rescan only if you have not
                finished scanning.
              </Small>
            ) : (
              <Small color={colors.statusGood}>
                Counts agree. The server still checks label by label.
              </Small>
            )}
          </Panel>

          {receive.isError ? (
            <Panel style={{ borderColor: colors.statusWarn }}>
              <Body color={colors.statusWarn}>
                {apiMessage(receive.error, "The receipt was not recorded.")}
              </Body>
            </Panel>
          ) : null}
        </>
      ) : null}

      {/* -------------------------------------------------------------- scan */}
      {step === "scan" && data?.canReceive !== false ? (
        <>
          <Card>
            <Input
              ref={inputRef}
              label="Scan every label out of the bag"
              code
              value={awb}
              onChangeText={setAwb}
              onSubmitEditing={add}
              returnKeyType="next"
              placeholder="NATEX…"
              autoFocus
            />
            <Button
              title="Add"
              variant="secondary"
              disabled={normaliseAwb(awb).length === 0}
              onPress={add}
            />
          </Card>

          <Panel>
            <View style={styles.row}>
              <Field label="Scanned" value={String(queue.length)} />
              <Field label="Expected" value={String(expected.length)} />
            </View>
            {offManifest > 0 ? (
              <Small color={colors.statusWarn}>
                {plural(offManifest, "scanned label")} not on this bag&apos;s manifest.
              </Small>
            ) : null}
            <Small>
              Scan what is physically there, not what the list says should be. The
              comparison happens server-side when you submit.
            </Small>
          </Panel>

          <Section>
            <Label>Scanned · {queue.length}</Label>
            {queue.length === 0 ? (
              <Empty title="Nothing scanned yet" detail="Start with the top of the bag." />
            ) : (
              queue.map((value) => (
                <Card key={value}>
                  <View style={styles.row}>
                    <Mono style={styles.flex}>{value}</Mono>
                    {expectedSet.has(value) ? (
                      <Badge tone="good">On manifest</Badge>
                    ) : (
                      <Badge tone="warn">Not listed</Badge>
                    )}
                    <Button
                      title="Remove"
                      variant="ghost"
                      onPress={() =>
                        setQueue((current) => current.filter((item) => item !== value))
                      }
                    />
                  </View>
                </Card>
              ))
            )}
          </Section>

          <Section>
            {revealExpected ? (
              <>
                <Label>Manifest · {expected.length}</Label>
                <Small>
                  What the origin hub sealed in. Reading labels off this list instead of off
                  the parcels is how a missing parcel gets signed for.
                </Small>
                {expected.map((value) => (
                  <Card key={value}>
                    <View style={styles.row}>
                      <Mono style={styles.flex}>{value}</Mono>
                      {queue.includes(value) ? <Badge tone="good">Scanned</Badge> : null}
                    </View>
                  </Card>
                ))}
              </>
            ) : (
              <Button
                title="Show the manifest"
                variant="ghost"
                hint="Only when a label will not scan"
                onPress={() => setRevealExpected(true)}
              />
            )}
          </Section>
        </>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: "row", alignItems: "center", gap: Space.unit * 1.5 },
});
