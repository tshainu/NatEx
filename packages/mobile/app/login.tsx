import React from "react";
import { Image, Pressable, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { useMutation } from "@tanstack/react-query";
import { StatusBar } from "expo-status-bar";
import { apiMessage, client } from "../lib/api";
import { useAuth } from "../lib/auth";
import { deviceId, homeRouteFor, type ApiSession } from "../lib/session";
import { Screen } from "../components/natex/screen";
import { Button } from "../components/natex/button";
import { Card, Panel } from "../components/natex/card";
import { Input } from "../components/natex/input";
import { Body, Label, Mono, Small } from "../components/natex/text";
import { Space } from "../constants/theme";
import { ThemeOverrideProvider, useColors } from "../hooks/use-colors";

/**
 * Username + password sign-in — phone + OTP stays available behind a toggle
 * for accounts without credentials. The role-specific workspace is selected
 * from the server-authenticated session.
 *
 * The device id goes up with the sign-in, not as a separate call — the API folds
 * device binding into `identity.loginPassword` / `identity.verifyOtp`, and for a
 * rider a new device id revokes the previous device's sessions (§5, "one active
 * device per rider"). That is why `lib/session.ts` mints the id once per install
 * and never again.
 */

const FIELD_LOGINS = [
  { role: "Rider · Colombo", phone: "+94771234567", name: "Karthik Selvaraj" },
  { role: "Transport · Colombo", phone: "+94776789012", name: "Murugan Thevarajah" },
  { role: "Transport · Kandy", phone: "+94777890123", name: "Vignesh Balasubramaniam" },
];

function gateSession<T extends { mfa: { state: string } }>(session: T): T {
  // §2 TOTP MFA (M5): ops, admin and finance finish sign-in with an
  // authenticator code. That step lives in the web portal; the field app
  // is for merchants, riders and transport, so a pending session is not stored here.
  if (session.mfa.state === "enrol" || session.mfa.state === "challenge") {
    throw new Error("This account signs in with an authenticator code. Use the NatEx web portal.");
  }
  return session;
}

export default function LoginScreen() {
  return (
    <ThemeOverrideProvider scheme="light">
      <StatusBar style="dark" />
      <LoginForm />
    </ThemeOverrideProvider>
  );
}

function LoginForm() {
  const colors = useColors();
  const { signIn } = useAuth();
  const [method, setMethod] = React.useState<"password" | "phone">("password");
  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
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
    mutationFn: async (input: { challengeId: string; code: string }) =>
      gateSession(await client.identity.verifyOtp({ ...input, deviceId: deviceId() })),
    onSuccess: async (session) => {
      const api = session as ApiSession;
      await signIn(api);
      router.replace(homeRouteFor(api.user.role));
    },
  });

  const passwordLogin = useMutation({
    mutationFn: async (input: { username: string; password: string }) =>
      gateSession(await client.identity.loginPassword({ ...input, deviceId: deviceId() })),
    onSuccess: async (session) => {
      const api = session as ApiSession;
      await signIn(api);
      router.replace(homeRouteFor(api.user.role));
    },
  });

  const busy = request.isPending || verify.isPending || passwordLogin.isPending;
  const error = request.error
    ? apiMessage(request.error, "Could not send the code.")
    : verify.error
      ? apiMessage(verify.error, "That code was not accepted.")
      : passwordLogin.error
        ? apiMessage(passwordLogin.error, "Sign-in failed.")
        : null;

  function reset(nextPhone: string) {
    setPhone(nextPhone);
    setChallenge(null);
    setCode("");
    request.reset();
    verify.reset();
  }

  const footer =
    method === "password" ? (
      <>
        <Button
          title="Sign in"
          loading={passwordLogin.isPending}
          disabled={username.trim().length < 2 || password.length === 0}
          onPress={() => passwordLogin.mutate({ username: username.trim(), password })}
        />
        <Button
          title="Use phone + SMS code instead"
          variant="ghost"
          disabled={busy}
          onPress={() => setMethod("phone")}
        />
      </>
    ) : challenge ? (
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
        <Button
          title="Use username + password instead"
          variant="ghost"
          disabled={busy}
          onPress={() => {
            reset(phone);
            setMethod("password");
          }}
        />
      </>
    ) : (
      <>
        <Button
          title="Send code"
          loading={request.isPending}
          disabled={phone.trim().length < 9}
          onPress={() => request.mutate(phone)}
        />
        <Button
          title="Use username + password instead"
          variant="ghost"
          disabled={busy}
          onPress={() => setMethod("password")}
        />
      </>
    );

  return (
    <Screen footer={footer}>
      <View style={styles.brand}>
        <View style={[styles.logoBadge, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Image
            source={require("../assets/natex-wordmark.jpg")}
            style={styles.logo}
            resizeMode="contain"
            accessibilityLabel="NatEx"
          />
        </View>
        <Small color={colors.mutedForeground} style={styles.tagline}>
          Sign in to book and manage NatEx deliveries. Your merchant or field workspace opens after sign-in.
        </Small>
      </View>

      {method === "password" ? (
        <Card>
          <Input
            label="Username"
            value={username}
            onChangeText={setUsername}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="e.g. karthik"
            autoFocus
          />
          <Input
            label="Password"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            placeholder="•••••���••"
          />
        </Card>
      ) : challenge ? (
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

      {method === "phone" ? (
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
      ) : null}

      <Small style={styles.device}>Device {deviceId()}</Small>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  brand: { alignItems: "center", paddingTop: Space.unit * 3, paddingBottom: Space.unit * 2 },
  logoBadge: {
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: "#E3E7ED",
    borderRadius: Space.radius,
    paddingHorizontal: Space.unit,
    paddingVertical: 4,
  },
  logo: { width: 240, height: 78 },
  tagline: { marginTop: Space.unit * 2, textAlign: "center", maxWidth: 300 },
  accountRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Space.unit,
    minHeight: Space.minTouch,
    paddingVertical: 6,
  },
  device: { opacity: 0.6 },
});
