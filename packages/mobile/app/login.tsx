import React from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { useMutation } from "@tanstack/react-query";
import { apiMessage, client } from "../lib/api";
import { useAuth } from "../lib/auth";
import { deviceId, homeRouteFor, type ApiSession } from "../lib/session";
import { Screen } from "../components/natex/screen";
import { Button } from "../components/natex/button";
import { Card, Panel } from "../components/natex/card";
import { Input } from "../components/natex/input";
import { Body, Display, Label, Mono, Small, Title } from "../components/natex/text";
import { Space } from "../constants/theme";
import { useColors } from "../hooks/use-colors";

/**
 * Phone + OTP sign-in (§2), two steps: request a challenge, then verify the
 * six-digit code.
 *
 * The device id goes up with the verify, not as a separate call — the API folds
 * device binding into `identity.verifyOtp`, and for a rider a new device id
 * revokes the previous device's sessions (§5, "one active device per rider").
 * That is why `lib/session.ts` mints the id once per install and never again.
 */

const FIELD_LOGINS = [
  { role: "Rider · Colombo", phone: "+94771234567", name: "Pradeep Fernando" },
  { role: "Transport · Colombo", phone: "+94776789012", name: "Suresh Kodikara" },
  { role: "Transport · Kandy", phone: "+94777890123", name: "Chamara Bandara" },
];

export default function LoginScreen() {
  const colors = useColors();
  const { signIn } = useAuth();
  const [phone, setPhone] = React.useState("");
  const [code, setCode] = React.useState("");
  const [challenge, setChallenge] = React.useState<{
    challengeId: string;
    expiresInSeconds: number;
    smsState: string;
    devCode?: string | null;
  } | null>(null);

  const request = useMutation({
    mutationFn: (value: string) => client.identity.requestOtp({ phone: value.trim() }),
    onSuccess: (data) => {
      setChallenge(data);
      // No SMS gateway in this environment, so the API hands the code back and
      // we prefill it rather than making the tester invent one.
      setCode(data.devCode ?? "");
    },
  });

  const verify = useMutation({
    mutationFn: async (input: { challengeId: string; code: string }) => {
      const session = await client.identity.verifyOtp({ ...input, deviceId: deviceId() });
      // §2 TOTP MFA (M5): ops, admin and finance finish sign-in with an
      // authenticator code. That step lives in the web portal; the field app
      // is for riders and transport, so a pending session is not stored here.
      if (session.mfa.state === "enrol" || session.mfa.state === "challenge") {
        throw new Error("This account signs in with an authenticator code. Use the NatEx web portal.");
      }
      return session;
    },
    onSuccess: async (session) => {
      const api = session as ApiSession;
      await signIn(api);
      router.replace(homeRouteFor(api.user.role));
    },
  });

  const busy = request.isPending || verify.isPending;
  const error = request.error
    ? apiMessage(request.error, "Could not send the code.")
    : verify.error
      ? apiMessage(verify.error, "That code was not accepted.")
      : null;

  function reset(nextPhone: string) {
    setPhone(nextPhone);
    setChallenge(null);
    setCode("");
    request.reset();
    verify.reset();
  }

  const footer = challenge ? (
    <>
      <Button
        title="Verify and sign in"
        loading={verify.isPending}
        disabled={code.trim().length < 4}
        onPress={() => verify.mutate({ challengeId: challenge.challengeId, code: code.trim() })}
      />
      <Button
        title="Use a different number"
        variant="ghost"
        disabled={busy}
        onPress={() => reset(phone)}
      />
    </>
  ) : (
    <Button
      title="Send code"
      loading={request.isPending}
      disabled={phone.trim().length < 9}
      onPress={() => request.mutate(phone)}
    />
  );

  return (
    <Screen footer={footer}>
      <View style={styles.brandRow}>
        <View style={[styles.mark, { backgroundColor: colors.primary }]}>
          <Title color={colors.primaryForeground}>N</Title>
        </View>
        <Display>NatEx</Display>
      </View>

      <Small style={styles.tagline}>
        Field app for riders and transport staff. Sign in with your registered phone
        number — a six-digit code is sent by SMS.
      </Small>

      {challenge ? (
        <Card>
          <Label>Code sent to</Label>
          <Mono>{phone.trim()}</Mono>
          <Input
            label="Six-digit code"
            code
            value={code}
            onChangeText={setCode}
            keyboardType="number-pad"
            maxLength={6}
            placeholder="000000"
            autoFocus
            hint={
              challenge.devCode
                ? "No SMS gateway configured here, so the code was returned in the response."
                : `Expires in ${Math.round(challenge.expiresInSeconds / 60)} minutes.`
            }
          />
        </Card>
      ) : (
        <Card>
          <Input
            label="Phone number"
            code
            value={phone}
            onChangeText={setPhone}
            keyboardType="phone-pad"
            placeholder="+9477…"
            autoFocus
            hint="The number your branch registered."
          />
        </Card>
      )}

      {error ? (
        <Panel style={{ borderColor: colors.statusWarn }}>
          <Body color={colors.statusWarn}>{error}</Body>
        </Panel>
      ) : null}

      <Panel>
        <Label>Seeded field accounts</Label>
        {FIELD_LOGINS.map((account) => (
          <Pressable
            key={account.phone}
            onPress={() => reset(account.phone)}
            accessibilityRole="button"
            accessibilityLabel={`Use ${account.name}, ${account.phone}`}
            style={({ pressed }) => [styles.accountRow, { opacity: pressed ? 0.7 : 1 }]}
          >
            <View style={styles.flex}>
              <Body>{account.name}</Body>
              <Small>{account.role}</Small>
            </View>
            <Mono color={colors.primary}>{account.phone}</Mono>
          </Pressable>
        ))}
      </Panel>

      <Small style={styles.device}>Device {deviceId()}</Small>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  brandRow: { flexDirection: "row", alignItems: "center", gap: Space.unit * 1.5 },
  mark: {
    width: 40,
    height: 40,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  tagline: { marginTop: -Space.unit },
  accountRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Space.unit,
    minHeight: Space.minTouch,
    paddingVertical: 6,
  },
  device: { opacity: 0.6 },
});
