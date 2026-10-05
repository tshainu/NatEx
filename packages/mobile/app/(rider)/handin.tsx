import React from "react";
import { StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiMessage, client, orpc } from "../../lib/api";
import { normaliseAwb, plural } from "../../lib/format";
import { Screen, ScreenHeader, Section } from "../../components/natex/screen";
import { Button } from "../../components/natex/button";
import { Card, Empty, Panel } from "../../components/natex/card";
import { Input } from "../../components/natex/input";
import { BarcodeScanner } from "../../components/natex/barcode-scanner";
import { Body, Label, Mono, Small } from "../../components/natex/text";
import { Space } from "../../constants/theme";
import { useColors } from "../../hooks/use-colors";

/**
 * End of the rider's run: hand the collected parcels in at the origin hub.
 *
 * Each label moves PickedUp → AtOriginHub through the state machine, and the
 * API answers **per label** rather than all-or-nothing — one parcel that was
 * never actually picked up must not block the other forty. So the list is built
 * locally first, submitted as a batch, and the response is shown as two lists:
 * what the hub took, and what it refused and why.
 */
export default function RiderHandInScreen() {
  const colors = useColors();
  const queryClient = useQueryClient();
  const [awb, setAwb] = React.useState("");
  const [queue, setQueue] = React.useState<string[]>([]);
  const [duplicate, setDuplicate] = React.useState<string | null>(null);
  const inputRef = React.useRef<React.ComponentRef<typeof Input>>(null);
  const [scannerOpen, setScannerOpen] = React.useState(false);

  const handIn = useMutation({
    mutationFn: (awbs: string[]) => client.collection.riderHandIn({ awbs }),
    onSuccess: (result) => {
      // Only the accepted labels leave the queue; a rejected one stays on screen
      // with its reason so the rider can deal with it at the counter.
      const accepted = new Set(result.received);
      setQueue((current) => current.filter((value) => !accepted.has(value)));
      void queryClient.invalidateQueries({ queryKey: orpc.collection.key() });
    },
  });

  function add(raw?: string) {
    const value = normaliseAwb(raw ?? awb);
    if (!value) return;
    if (queue.includes(value)) {
      setDuplicate(value);
      setAwb("");
      return;
    }
    setQueue((current) => [value, ...current]);
    setAwb("");
    setDuplicate(null);
    handIn.reset();
    inputRef.current?.focus();
  }

  const result = handIn.data;

  return (
    <Screen
      inTabs
      footer={
        <>
          <Button
            title={`Hand in ${plural(queue.length, "parcel")}`}
            loading={handIn.isPending}
            disabled={queue.length === 0}
            hint={queue.length === 0 ? "Add at least one label" : undefined}
            onPress={() => handIn.mutate(queue)}
          />
          {queue.length > 0 && !handIn.isPending ? (
            <Button title="Clear list" variant="ghost" onPress={() => setQueue([])} />
          ) : null}
        </>
      }
    >
      <ScreenHeader
        title="Hand in at hub"
        subtitle="Scan everything you collected, then submit as one batch."
      />

      <Card>
        <Input
          ref={inputRef}
          label="Scan or type AWB"
          code
          value={awb}
          onChangeText={(value) => {
            setAwb(value);
            setDuplicate(null);
          }}
          onSubmitEditing={() => add()}
          returnKeyType="next"
          placeholder="NATEX…"
        />
        <Button
          title="Scan with camera"
          variant="secondary"
          icon={<Ionicons name="barcode-outline" size={18} color={colors.foreground} />}
          onPress={() => setScannerOpen(true)}
        />
        <Button
          title="Add to list"
          variant="secondary"
          disabled={normaliseAwb(awb).length === 0}
          onPress={() => add()}
        />
        {duplicate ? (
          <Small color={colors.statusMoving}>{duplicate} is already on the list.</Small>
        ) : null}
      </Card>

      {handIn.isError ? (
        <Panel style={{ borderColor: colors.statusWarn }}>
          <Body color={colors.statusWarn}>
            {apiMessage(handIn.error, "The hub could not take these parcels.")}
          </Body>
        </Panel>
      ) : null}

      {result ? (
        <Panel
          style={{
            borderColor: result.rejected.length > 0 ? colors.statusMoving : colors.statusGood,
          }}
        >
          <Body
            color={result.rejected.length > 0 ? colors.statusMoving : colors.statusGood}
          >
            {result.received.length} received
            {result.rejected.length > 0 ? `, ${result.rejected.length} refused` : ""}.
          </Body>
          {result.rejected.map((row) => (
            <View key={row.awb} style={styles.rejectRow}>
              <Mono color={colors.statusWarn}>{row.awb}</Mono>
              <Small style={styles.flex}>{row.reason}</Small>
            </View>
          ))}
        </Panel>
      ) : null}

      {queue.length === 0 ? (
        <Empty
          title="Nothing queued"
          detail="Labels you add appear here before you submit them."
        />
      ) : (
        <Section>
          <Label>To hand in · {queue.length}</Label>
          {queue.map((value) => {
            const refusal = result?.rejected.find((row) => row.awb === value);
            return (
              <Card key={value}>
                <View style={styles.row}>
                  <Mono style={styles.flex} color={refusal ? colors.statusWarn : undefined}>
                    {value}
                  </Mono>
                  <Button
                    title="Remove"
                    variant="ghost"
                    onPress={() =>
                      setQueue((current) => current.filter((item) => item !== value))
                    }
                  />
                </View>
                {refusal ? <Small color={colors.statusWarn}>{refusal.reason}</Small> : null}
              </Card>
            );
          })}
        </Section>
      )}
      <BarcodeScanner
        visible={scannerOpen}
        onClose={() => setScannerOpen(false)}
        onScanned={(value) => {
          setScannerOpen(false);
          add(value);
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: "row", alignItems: "center", gap: Space.unit },
  rejectRow: { flexDirection: "row", alignItems: "center", gap: Space.unit },
});
