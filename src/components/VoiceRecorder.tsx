import React, { useState, useRef, useCallback } from 'react';
import type { VoiceNote } from '../global';

interface VoiceRecorderProps {
    onRecordingComplete: (voiceNote: VoiceNote) => void;
    disabled?: boolean;
}

type RecordingState = 'idle' | 'recording' | 'saving';

/**
 * Voice recorder component using MediaRecorder API
 * Captures audio and saves as voice note via IPC
 */
export function VoiceRecorder({ onRecordingComplete, disabled }: VoiceRecorderProps): React.ReactElement {
    const [state, setState] = useState<RecordingState>('idle');
    const [duration, setDuration] = useState(0);
    const [error, setError] = useState<string | null>(null);

    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const chunksRef = useRef<Blob[]>([]);
    const timerRef = useRef<NodeJS.Timeout | null>(null);
    const streamRef = useRef<MediaStream | null>(null);

    const startRecording = useCallback(async () => {
        setError(null);
        chunksRef.current = [];

        try {
            // Request microphone access
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                }
            });
            streamRef.current = stream;

            // Determine best supported format
            const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
                ? 'audio/webm;codecs=opus'
                : MediaRecorder.isTypeSupported('audio/webm')
                    ? 'audio/webm'
                    : 'audio/ogg';

            const mediaRecorder = new MediaRecorder(stream, { mimeType });
            mediaRecorderRef.current = mediaRecorder;

            mediaRecorder.ondataavailable = (event) => {
                if (event.data.size > 0) {
                    chunksRef.current.push(event.data);
                }
            };

            mediaRecorder.onstop = async () => {
                setState('saving');

                // Create blob from chunks
                const blob = new Blob(chunksRef.current, { type: mimeType });

                try {
                    // Convert to ArrayBuffer
                    const arrayBuffer = await blob.arrayBuffer();

                    // Determine extension based on mime type
                    const extension = mimeType.includes('webm') ? 'webm' : 'ogg';

                    // Save via IPC
                    const voiceNote = await window.api.voice.saveNote(arrayBuffer, extension);

                    console.log(`[VoiceRecorder] Saved voice note: ${voiceNote.id}`);
                    onRecordingComplete(voiceNote);
                } catch (err) {
                    console.error('[VoiceRecorder] Failed to save:', err);
                    setError(err instanceof Error ? err.message : 'Failed to save recording');
                } finally {
                    setState('idle');
                    setDuration(0);
                }
            };

            // Start recording
            mediaRecorder.start(100); // Collect data every 100ms
            setState('recording');
            setDuration(0);

            // Start duration timer
            timerRef.current = setInterval(() => {
                setDuration(d => d + 1);
            }, 1000);

        } catch (err) {
            console.error('[VoiceRecorder] Failed to start:', err);
            if (err instanceof Error) {
                if (err.name === 'NotAllowedError') {
                    setError('Microphone access denied. Please allow microphone access.');
                } else if (err.name === 'NotFoundError') {
                    setError('No microphone found. Please connect a microphone.');
                } else {
                    setError(err.message);
                }
            } else {
                setError('Failed to start recording');
            }
        }
    }, [onRecordingComplete]);

    const stopRecording = useCallback(() => {
        if (mediaRecorderRef.current && state === 'recording') {
            mediaRecorderRef.current.stop();

            // Stop all tracks
            if (streamRef.current) {
                streamRef.current.getTracks().forEach(track => track.stop());
                streamRef.current = null;
            }

            // Clear timer
            if (timerRef.current) {
                clearInterval(timerRef.current);
                timerRef.current = null;
            }
        }
    }, [state]);

    const formatDuration = (seconds: number): string => {
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    };

    const handleClick = () => {
        if (state === 'idle') {
            startRecording();
        } else if (state === 'recording') {
            stopRecording();
        }
    };

    return (
        <div className="voice-recorder">
            <button
                className={`voice-recorder-button ${state}`}
                onClick={handleClick}
                disabled={disabled || state === 'saving'}
                title={state === 'idle' ? 'Start recording' : state === 'recording' ? 'Stop recording' : 'Saving...'}
            >
                {state === 'idle' && <span className="voice-icon">🎤</span>}
                {state === 'recording' && <span className="voice-icon recording">⏹️</span>}
                {state === 'saving' && <span className="voice-icon saving">💾</span>}
            </button>

            {state === 'recording' && (
                <span className="voice-duration">{formatDuration(duration)}</span>
            )}

            {state === 'saving' && (
                <span className="voice-status">Saving...</span>
            )}

            {error && (
                <span className="voice-error" title={error}>⚠️</span>
            )}
        </div>
    );
}

export default VoiceRecorder;
