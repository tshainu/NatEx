import { StyleSheet } from "react-native";
import { router } from "expo-router";
import { Screen, ScreenHeader } from "../components/natex/screen";
import { Button } from "../components/natex/button";
import { Field, Panel } from "../components/natex/card";
import { Body, Small } from "../components/natex/text";
import { useAuth } from "../lib/auth";
import { humanise } from "../lib/format";
import { Space } from "../constants/theme";

/**
 * Where back-office roles land. Ops, finance, admin and merchant users have no
 * field workflow — their work is the web portals, which are built for a mouse
 * and a wide table. Rather than shipping a cramped phone version of a screen
 * nobody would use on a phone, this says so plainly and offers the way out.
 */
export default function DeskScreen() {
  const { user, role, signOut } = useAuth();

  return (
    <Screen
      footer={
        <Button
          title="Sign out"
          variant="secondary"
          onPress={async () => {
            await signOut();
            router.replace("/login");
          }}
        />
      }
    >
      <ScreenHeader
        title="Use the web portal"
        subtitle={`Signed in as ${user?.name ?? "—"}`}
      />

      <Panel>
        <Body>
          The field app covers pickup collection for riders and hub custody for
          transport staff. {role ? humanise(role) : "This"} work — booking, pricing,
          reconciliation, settlements and configuration — lives in the web portal,
          where the tables are wide enough to read.
        </Body>
        <Small style={styles.note}>
          Open the NatEx web app in a browser and sign in with this same phone number.
        </Small>
      </Panel>

      <Panel>
        <Field label="Role" value={role ? humanise(role) : "—"} />
        <Field label="Branch" value={user?.branchName} />
        <Field label="Phone-bound device" value={user?.deviceId ?? "not bound"} mono />
      </Panel>
    </Screen>
  );
}

const styles = StyleSheet.create({
  note: { marginTop: Space.unit / 2 },
});
