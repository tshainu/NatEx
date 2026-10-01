import { router } from "expo-router";
import { Screen, ScreenHeader } from "./screen";
import { Button } from "./button";
import { Field, Panel } from "./card";
import { Body, Label, Small } from "./text";
import { useAuth } from "../../lib/auth";
import { deviceId } from "../../lib/session";
import { humanise } from "../../lib/format";

/**
 * The "Me" tab, shared by both role groups — identical for a rider and a
 * transport clerk, so it exists once.
 *
 * The device id is on screen on purpose: §5 binds a rider to one active device
 * and a re-bind silently revokes the other one's sessions. When a rider says
 * "it logged me out", this is the field that explains it, and it is the field an
 * ops person will ask them to read out.
 */
export function ProfileScreen({ note }: { note?: string }) {
  const { user, role, signOut } = useAuth();

  return (
    <Screen
      inTabs
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
      <ScreenHeader title={user?.name ?? "Signed in"} subtitle={role ? humanise(role) : undefined} />

      <Panel>
        <Field label="Branch" value={user?.branchName} />
        <Field label="Role" value={role ? humanise(role) : "—"} />
      </Panel>

      <Panel>
        <Label>This device</Label>
        <Small>
          Signing in on another phone moves your account to it and ends this session.
        </Small>
        <Field label="Device id" value={deviceId()} mono />
        {user?.deviceId ? <Field label="Bound device" value={user.deviceId} mono /> : null}
      </Panel>

      {note ? (
        <Panel>
          <Body>{note}</Body>
        </Panel>
      ) : null}
    </Screen>
  );
}
