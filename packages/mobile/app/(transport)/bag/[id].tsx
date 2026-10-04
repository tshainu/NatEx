import React from "react";
import { Image, Platform, StyleSheet, View } from "react-native";
import * as ImagePicker from "expo-image-picker";
import { useLocalSearchParams, router } from "expo-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiMessage, client, orpc } from "../../../lib/api";
import { dateTime, grams, normaliseAwb, plural } from "../../../lib/format";
import { Screen, ScreenHeader, Section } from "../../../components/natex/screen";
import { Button } from "../../../components/natex/button";
import { Card, Empty, Field, Panel } from "../../../components/natex/card";
import { Input } from "../../../components/natex/input";
import { Badge, LifecyclePill } from "../../../components/natex/pill";
import { Body, Label, Mono, Small } from "../../../components/natex/text";
import { Space } from "../../../constants/theme";
import { useColors } from "../../../hooks/use-colors";

type Mode = "scan" | "seal" | "break";

/**
 * One bag: fill it, then seal it.
 *
 * Two things here come straight from §7 and are deliberately not softened.
 * First, the server tells this screen what it may do next (`canScan`,
 * `canSeal`) — the client never infers legality from a status string, because
 * the branch-scoping rules mean a Kandy clerk looking at a Colombo bag sees
 * different permissions for the same status. Second, breaking a seal is an
 * exception, not an edit: it demands a written reason and says so.
 */
export default function BagScreen() {
  const colors = useColors();
  const queryClient = useQueryClient();
  const { id } = useLocalSearchParams<{ id: string }>();
  const bagId = String(id);

  const [mode, setMode] = React.useState<Mode>("scan");
  const [awb, setAwb] = React.useState("");
  const [queue, setQueue] = React.useState<string[]>([]);
  const [seal, setSeal] = React.useState("");
  const [reason, setReason] = React.useState("");
  const inputRef = React.useRef<React.ComponentRef<typeof Input>>(null);

  const detail = useQuery(orpc.transport.bagGet.queryOptions({ input: { bagId } }));

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: orpc.transport.key() });
  }

  const scan = useMutation({
    mutationFn: (awbs: string[]) => client.transport.bagScan({ bagId, awbs }),
    onSuccess: (result) => {
      // Accepted and duplicate labels are both "in the bag" as far as the floor
      // is concerned, so both leave the queue; only rejects stay for the clerk.
      const settled = new Set([
        ...result.accepted.map((l) => l.awb),
        ...result.duplicates.map((l) => l.awb),
      ]);
      setQueue((current) => current.filter((value) => !settled.has(value)));
      invalidate();
    },
  });

  const sealBag = useMutation({
    mutationFn: () => client.transport.bagSeal({ bagId, sealNumber: seal.trim() }),
    onSuccess: () => {
      invalidate();
      setSeal("");
      setMode("scan");
    },
  });

  const breakSeal = useMutation({
    mutationFn: () => client.transport.bagBreakSeal({ bagId, reason: reason.trim() }),
    onSuccess: () => {
      invalidate();
      setReason("");
      setMode("scan");
    },
  });

  const remove = useMutation({
    mutationFn: (value: string) => client.transport.bagRemove({ bagId, awb: value }),
    onSuccess: invalidate,
  });

  const data = detail.data;
  const bag = data?.bag;

  // Optional bag photo (Round 6): slot → PUT straight to the bucket → attach.
  const photo = useMutation({
    mutationFn: async () => {
      const opts: ImagePicker.ImagePickerOptions = { mediaTypes: ["images"], quality: 0.6 };
      if (Platform.OS !== "web") {
        const perm = await ImagePicker.requestCameraPermissionsAsync();
        if (!perm.granted) throw new Error("Camera permission is needed for a bag photo.");
      }
      const shot =
        Platform.OS === "web"
          ? await ImagePicker.launchImageLibraryAsync(opts)
          : await ImagePicker.launchCameraAsync(opts);
      if (shot.canceled || !shot.assets[0]) return null;
      const asset = shot.assets[0];
      const contentType = (asset.mimeType ?? "image/jpeg") as "image/jpeg" | "image/png" | "image/webp";
      const slot = await client.transport.bagPhotoUpload({ bagId, contentType });
      const blob = await (await fetch(asset.uri)).blob();
      const put = await fetch(slot.uploadUrl, { method: "PUT", body: blob, headers: { "Content-Type": contentType } });
      if (!put.ok) throw new Error(`Photo upload failed (${put.status}). Try again with signal.`);
      return client.transport.bagPhotoAttach({ bagId, storageRef: slot.storageRef });
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: orpc.transport.key() }),
  });
  const photoView = useQuery({
    ...orpc.transport.bagPhotoView.queryOptions({ input: { bagId } }),
    enabled: Boolean(bag?.photoRef),
    staleTime: 4 * 60_000,
  });
  const items = (data?.items ?? []).filter((item) => item.removedAt === null);

  function add() {
    const value = normaliseAwb(awb);
    if (!value) return;
    setQueue((current) => (current.includes(value) ? current : [value, ...current]));
    setAwb("");
    scan.reset();
    inputRef.current?.focus();
  }

  const result = scan.data;

  let footer: React.ReactNode = null;
  if (mode === "seal") {
    footer = (
      <>
        <Button
          title="Seal bag"
          loading={sealBag.isPending}
          disabled={seal.trim().length < 3}
          onPress={() => sealBag.mutate()}
        />
        <Button title="Cancel" variant="ghost" onPress={() => setMode("scan")} />
      </>
    );
  } else if (mode === "break") {
    footer = (
      <>
        <Button
          title="Break seal and raise exception"
          variant="danger"
          loading={breakSeal.isPending}
          disabled={reason.trim().length < 5}
          onPress={() => breakSeal.mutate()}
        />
        <Button title="Cancel" variant="ghost" onPress={() => setMode("scan")} />
      </>
    );
  } else if (queue.length > 0) {
    footer = (
      <>
        <Button
          title={`Scan ${plural(queue.length, "label")} into bag`}
          loading={scan.isPending}
          onPress={() => scan.mutate(queue)}
        />
        <Button title="Clear queue" variant="ghost" onPress={() => setQueue([])} />
      </>
    );
  } else if (data?.canSeal) {
    footer = (
      <Button
        title="Seal bag"
        disabled={items.length === 0}
        hint={items.length === 0 ? "An empty bag cannot be sealed" : undefined}
        onPress={() => setMode("seal")}
      />
    );
  } else if (bag?.status === "sealed") {
    footer = (
      <>
        <Button
          title="Load onto a trip"
          variant="secondary"
          onPress={() => router.push("/(transport)/trips")}
        />
        <Button title="Break seal" variant="ghost" onPress={() => setMode("break")} />
      </>
    );
  } else {
    footer = <Button title="Back to bags" variant="secondary" onPress={() => router.back()} />;
  }

  return (
    <Screen
      inTabs
      footer={footer}
      refreshing={detail.isRefetching}
      onRefresh={() => void detail.refetch()}
    >
      <ScreenHeader
        title={bag?.code ?? "Bag"}
        subtitle={data ? `${data.originHubName} → ${data.destHubName}` : undefined}
        right={bag ? <LifecyclePill status={bag.status} /> : undefined}
      />

      {detail.isError ? (
        <Panel style={{ borderColor: colors.statusWarn }}>
          <Body color={colors.statusWarn}>
            {apiMessage(detail.error, "Could not load this bag.")}
          </Body>
        </Panel>
      ) : null}

      <Panel>
        <View style={styles.row}>
          <Field label="Parcels" value={String(items.length)} />
          <Field label="Weight" value={bag?.weightGrams ? grams(bag.weightGrams) : "—"} />
        </View>
        <View style={styles.row}>
          <Field label="Seal" value={bag?.sealNumber ?? "not sealed"} mono />
          <Field
            label="Sealed by"
            value={bag?.sealedByName ? `${bag.sealedByName}` : "—"}
          />
        </View>
        {bag?.sealedAt ? <Field label="Sealed at" value={dateTime(bag.sealedAt)} /> : null}
        {photoView.data ? (
          <Image
            source={{ uri: photoView.data.url }}
            accessibilityLabel={`Photo of bag ${bag?.code ?? ""}`}
            style={styles.photo}
          />
        ) : null}
        {bag && bag.status !== "cancelled" ? (
          <Button
            title={bag.photoRef ? "Replace bag photo" : "Add bag photo (optional)"}
            variant="ghost"
            loading={photo.isPending}
            onPress={() => photo.mutate()}
          />
        ) : null}
        {photo.isError ? (
          <Small color={colors.statusWarn}>{apiMessage(photo.error, "The photo was not saved.")}</Small>
        ) : null}
        {data?.trip ? (
          <Card onPress={() => router.push(`/(transport)/trip/${data.trip!.id}`)}>
            <Label>On trip</Label>
            <View style={styles.row}>
              <Mono style={styles.flex}>{data.trip.code}</Mono>
              <LifecyclePill status={data.trip.status} />
            </View>
          </Card>
        ) : null}
      </Panel>

      {mode === "seal" ? (
        <Card>
          <Label>Seal number</Label>
          <Small>
            Read the number off the physical seal you just fitted. The destination hub
            checks this exact string on receipt, and a mismatch becomes an exception.
          </Small>
          <Input code value={seal} onChangeText={setSeal} placeholder="SL-000000" autoFocus />
          {sealBag.isError ? (
            <Small color={colors.statusWarn}>
              {apiMessage(sealBag.error, "The bag was not sealed.")}
            </Small>
          ) : null}
        </Card>
      ) : mode === "break" ? (
        <Card style={{ borderColor: colors.statusWarn }}>
          <Label>Why is this seal being broken?</Label>
          <Small>
            Breaking a seal is always recorded as a custody exception, never a quiet
            correction. This text goes into the exception and the audit trail.
          </Small>
          <Input
            value={reason}
            onChangeText={setReason}
            placeholder="Wrong parcel bagged; re-sorting before departure"
            multiline
            autoFocus
          />
          {breakSeal.isError ? (
            <Small color={colors.statusWarn}>
              {apiMessage(breakSeal.error, "The seal was not broken.")}
            </Small>
          ) : null}
        </Card>
      ) : data?.canScan ? (
        <Card>
          <Input
            ref={inputRef}
            label="Scan labels into this bag"
            code
            value={awb}
            onChangeText={setAwb}
            onSubmitEditing={add}
            returnKeyType="next"
            placeholder="NATEX…"
          />
          <Button
            title="Add to queue"
            variant="secondary"
            disabled={normaliseAwb(awb).length === 0}
            onPress={add}
          />
          <Small>
            Queue the whole burst, then submit once — the API answers per label, so one
            stray never blocks the rest.
          </Small>
        </Card>
      ) : (
        <Panel>
          <Small>
            This bag cannot be scanned into
            {bag?.status ? ` while it is ${bag.status.replace("_", " ")}` : ""}.
          </Small>
        </Panel>
      )}

      {scan.isError ? (
        <Panel style={{ borderColor: colors.statusWarn }}>
          <Body color={colors.statusWarn}>{apiMessage(scan.error, "The scan failed.")}</Body>
        </Panel>
      ) : null}

      {result ? (
        <Panel
          style={{
            borderColor: result.rejected.length > 0 ? colors.statusWarn : colors.statusGood,
          }}
        >
          <Body color={result.rejected.length > 0 ? colors.statusWarn : colors.statusGood}>
            {result.accepted.length} accepted
            {result.duplicates.length > 0 ? `, ${result.duplicates.length} already in bag` : ""}
            {result.rejected.length > 0 ? `, ${result.rejected.length} rejected` : ""}.
          </Body>
          {result.rejected.map((line) => (
            <View key={line.awb} style={styles.row}>
              <Mono color={colors.statusWarn}>{line.awb}</Mono>
              <Small style={styles.flex}>{line.reason ?? "Rejected"}</Small>
            </View>
          ))}
        </Panel>
      ) : null}

      {queue.length > 0 ? (
        <Section>
          <Label>Queued · {queue.length}</Label>
          {queue.map((value) => (
            <Card key={value}>
              <View style={styles.row}>
                <Mono style={styles.flex}>{value}</Mono>
                <Button
                  title="Remove"
                  variant="ghost"
                  onPress={() =>
                    setQueue((current) => current.filter((item) => item !== value))
                  }
                />
              </View>
            </Card>
          ))}
        </Section>
      ) : null}

      <Section>
        <Label>In this bag · {items.length}</Label>
        {items.length === 0 ? (
          <Empty title="Empty bag" detail="Scan labels above to fill it." />
        ) : (
          items.map((item) => (
            <Card key={item.id}>
              <View style={styles.row}>
                <Mono style={styles.flex}>{item.awb}</Mono>
                {data?.canScan ? (
                  <Button
                    title="Remove"
                    variant="ghost"
                    loading={remove.isPending && remove.variables === item.awb}
                    onPress={() => remove.mutate(item.awb)}
                  />
                ) : (
                  <Badge>In bag</Badge>
                )}
              </View>
              {item.scannedAt ? <Small>Scanned {dateTime(item.scannedAt)}</Small> : null}
            </Card>
          ))
        )}
        {remove.isError ? (
          <Small color={colors.statusWarn}>
            {apiMessage(remove.error, "That parcel was not removed.")}
          </Small>
        ) : null}
      </Section>
    </Screen>
  );
}

const styles = StyleSheet.create({
  photo: { width: "100%", aspectRatio: 4 / 3, borderRadius: Space.radius },
  flex: { flex: 1 },
  row: { flexDirection: "row", alignItems: "center", gap: Space.unit * 1.5 },
});
