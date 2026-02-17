import React, { useMemo, useState } from 'react';
import { Button, ScrollView, Text, TextInput, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';

function makeEventId() {
  return `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export default function App() {
  const [serverUrl, setServerUrl] = useState('http://127.0.0.1:8787');
  const [userId, setUserId] = useState('dev-user');
  const [workspaceId, setWorkspaceId] = useState('workspace-1');
  const [token, setToken] = useState(null);

  const [events, setEvents] = useState([]);
  const [lastPulledSeq, setLastPulledSeq] = useState(0);
  const [noteTitle, setNoteTitle] = useState('');
  const [noteBody, setNoteBody] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const inbox = useMemo(() => {
    return events
      .filter((event) => event.type === 'capture.text.create')
      .sort((a, b) => b.createdAtMs - a.createdAtMs)
      .map((event) => ({
        id: `atom:${event.payload.atomId}`,
        title: event.payload.title || event.payload.body.split('\n')[0] || 'Untitled',
        preview: event.payload.body,
        syncStatus: typeof event.serverSeq === 'number' ? 'synced' : 'waiting_sync',
      }));
  }, [events]);

  async function signIn() {
    setError('');
    setMessage('');
    try {
      const response = await fetch(`${serverUrl.replace(/\/+$/, '')}/auth/dev`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId, workspaceId }),
      });
      if (!response.ok) {
        throw new Error(`Sign-in failed (${response.status})`);
      }
      const payload = await response.json();
      setToken(payload.token);
      setMessage('Signed in.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed');
    }
  }

  function capture() {
    if (!noteBody.trim()) return;
    const atomId = `atom_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    setEvents((prev) => [
      {
        eventId: makeEventId(),
        eventSchemaVersion: 1,
        type: 'capture.text.create',
        createdAtMs: Date.now(),
        deviceId: 'mobile-device',
        workspaceId,
        localSeq: prev.length + 1,
        payload: {
          atomId,
          title: noteTitle || undefined,
          body: noteBody,
        },
      },
      ...prev,
    ]);
    setNoteTitle('');
    setNoteBody('');
    setMessage('Saved locally.');
    setError('');
  }

  async function syncNow() {
    if (!token) return;
    setError('');
    setMessage('');

    try {
      const pending = events.filter((event) => typeof event.serverSeq !== 'number');
      if (pending.length > 0) {
        const pushResponse = await fetch(`${serverUrl.replace(/\/+$/, '')}/sync/push`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            workspaceId,
            userId,
            deviceId: 'mobile-device',
            clientCursor: lastPulledSeq,
            events: pending,
          }),
        });

        if (!pushResponse.ok) {
          throw new Error(`Push failed (${pushResponse.status})`);
        }

        const pushPayload = await pushResponse.json();
        const mapping = new Map(pushPayload.accepted.map((entry) => [entry.eventId, entry.serverSeq]));
        setEvents((prev) => prev.map((event) => (
          mapping.has(event.eventId)
            ? { ...event, serverSeq: mapping.get(event.eventId) }
            : event
        )));
      }

      const pullResponse = await fetch(`${serverUrl.replace(/\/+$/, '')}/sync/pull?cursor=${lastPulledSeq}`, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${token}`,
        },
      });

      if (!pullResponse.ok) {
        throw new Error(`Pull failed (${pullResponse.status})`);
      }

      const pullPayload = await pullResponse.json();
      const incoming = pullPayload.events || [];

      if (incoming.length > 0) {
        setEvents((prev) => {
          const map = new Map(prev.map((event) => [event.eventId, event]));
          incoming.forEach((event) => map.set(event.eventId, event));
          return Array.from(map.values());
        });
      }

      setLastPulledSeq(Math.max(lastPulledSeq, pullPayload.cursor || 0));
      setMessage('Sync complete.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sync failed');
    }
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: '#fff' }} contentContainerStyle={{ padding: 16, gap: 12 }}>
      <StatusBar style="dark" />
      <Text style={{ fontSize: 24, fontWeight: '700' }}>SeedWorld Mobile</Text>

      <View style={{ gap: 8, borderWidth: 1, borderColor: '#ddd', padding: 12, borderRadius: 8 }}>
        <Text style={{ fontSize: 18, fontWeight: '600' }}>Sign in (Dev Auth)</Text>
        <TextInput style={{ borderWidth: 1, borderColor: '#ccc', borderRadius: 6, padding: 8 }} value={serverUrl} onChangeText={setServerUrl} placeholder="Server URL" />
        <TextInput style={{ borderWidth: 1, borderColor: '#ccc', borderRadius: 6, padding: 8 }} value={userId} onChangeText={setUserId} placeholder="User ID" />
        <TextInput style={{ borderWidth: 1, borderColor: '#ccc', borderRadius: 6, padding: 8 }} value={workspaceId} onChangeText={setWorkspaceId} placeholder="Workspace ID" />
        <Button title={token ? 'Signed in' : 'Sign in'} onPress={signIn} />
      </View>

      <View style={{ gap: 8, borderWidth: 1, borderColor: '#ddd', padding: 12, borderRadius: 8 }}>
        <Text style={{ fontSize: 18, fontWeight: '600' }}>Quick Capture</Text>
        <TextInput style={{ borderWidth: 1, borderColor: '#ccc', borderRadius: 6, padding: 8 }} value={noteTitle} onChangeText={setNoteTitle} placeholder="Title (optional)" />
        <TextInput
          style={{ borderWidth: 1, borderColor: '#ccc', borderRadius: 6, padding: 8, minHeight: 80 }}
          value={noteBody}
          onChangeText={setNoteBody}
          placeholder="Capture text"
          multiline
        />
        <Button title="Save Locally" onPress={capture} />
        <Button title="Sync now" onPress={syncNow} disabled={!token} />
      </View>

      {message ? <Text style={{ color: '#0a7f35' }}>{message}</Text> : null}
      {error ? <Text style={{ color: '#b00020' }}>{error}</Text> : null}

      <View style={{ gap: 8, borderWidth: 1, borderColor: '#ddd', padding: 12, borderRadius: 8 }}>
        <Text style={{ fontSize: 18, fontWeight: '600' }}>Inbox ({inbox.length})</Text>
        {inbox.map((item) => (
          <View key={item.id} style={{ borderWidth: 1, borderColor: '#eee', borderRadius: 8, padding: 8 }}>
            <Text style={{ fontWeight: '600' }}>{item.title}</Text>
            <Text style={{ fontSize: 12, color: '#555' }}>{item.id} · {item.syncStatus}</Text>
            <Text>{item.preview}</Text>
          </View>
        ))}
      </View>
    </ScrollView>
  );
}
