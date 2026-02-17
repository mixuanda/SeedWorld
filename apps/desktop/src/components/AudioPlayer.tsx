import React, { useState, useRef, useEffect } from 'react';

interface AudioPlayerProps {
    audioPath: string;  // Relative path within vault
}

const PLAYBACK_SPEEDS = [1.0, 1.25, 1.5, 2.0];

/**
 * Audio player component for voice notes
 * Uses seedworld:// protocol for secure streaming
 */
export function AudioPlayer({ audioPath }: AudioPlayerProps): React.ReactElement {
    const audioRef = useRef<HTMLAudioElement>(null);
    const audioPathRef = useRef(audioPath);
    const fallbackAttemptedRef = useRef(false);
    const wasPlayingRef = useRef(false);
    const pendingPlayRef = useRef(false);
    const resumeAfterSourceChangeRef = useRef(false);
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [playbackRate, setPlaybackRate] = useState(1.0);
    const [sourceUrl, setSourceUrl] = useState(() => window.api.attachment.getUrl(audioPath));
    const [usingFallback, setUsingFallback] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [errorDetails, setErrorDetails] = useState<{
        code: number | null;
        src: string;
        readyState: number;
        networkState: number;
    } | null>(null);

    useEffect(() => {
        audioPathRef.current = audioPath;
        fallbackAttemptedRef.current = false;
        wasPlayingRef.current = false;
        pendingPlayRef.current = false;
        resumeAfterSourceChangeRef.current = false;
        setSourceUrl(window.api.attachment.getUrl(audioPath));
        setUsingFallback(false);
        setError(null);
        setErrorDetails(null);
        setCurrentTime(0);
        setDuration(0);
    }, [audioPath]);

    useEffect(() => {
        const audio = audioRef.current;
        if (!audio) return;
        audio.load();
        if (resumeAfterSourceChangeRef.current) {
            resumeAfterSourceChangeRef.current = false;
            audio.play().catch(err => {
                console.error('[AudioPlayer] Resume after source change failed:', err);
            });
        }
    }, [sourceUrl]);

    const decodeMediaError = (mediaError: MediaError | null): string => {
        if (!mediaError) return 'Unknown media error';
        switch (mediaError.code) {
            case MediaError.MEDIA_ERR_ABORTED:
                return 'Playback was aborted (MEDIA_ERR_ABORTED).';
            case MediaError.MEDIA_ERR_NETWORK:
                return 'A network error interrupted the audio download (MEDIA_ERR_NETWORK).';
            case MediaError.MEDIA_ERR_DECODE:
                return 'The audio could not be decoded (MEDIA_ERR_DECODE).';
            case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
                return 'The audio format is not supported or the source is unavailable (MEDIA_ERR_SRC_NOT_SUPPORTED).';
            default:
                return `Unknown media error (code ${mediaError.code}).`;
        }
    };

    useEffect(() => {
        const audio = audioRef.current;
        if (!audio) return;

        const logEvent = (eventName: string, detail?: string) => {
            console.log(`[AudioPlayer] ${eventName}`, {
                src: audio.currentSrc,
                readyState: audio.readyState,
                networkState: audio.networkState,
                currentTime: audio.currentTime,
                duration: audio.duration,
                errorCode: audio.error?.code ?? null,
                detail,
            });
        };

        const handleTimeUpdate = () => setCurrentTime(audio.currentTime);
        const handleDurationChange = () => setDuration(audio.duration);
        const handlePlay = () => {
            wasPlayingRef.current = true;
            pendingPlayRef.current = false;
            setIsPlaying(true);
        };
        const handlePause = () => {
            wasPlayingRef.current = false;
            setIsPlaying(false);
        };
        const handleEnded = () => {
            wasPlayingRef.current = false;
            setIsPlaying(false);
        };
        const attemptFallback = async (reason: string, force: boolean) => {
            if (fallbackAttemptedRef.current || usingFallback) {
                return;
            }

            const shouldAttempt = force || wasPlayingRef.current || pendingPlayRef.current;
            if (!shouldAttempt) {
                return;
            }

            fallbackAttemptedRef.current = true;
            try {
                const fallbackUrl = await window.api.attachment.getStreamUrl(audioPathRef.current);
                console.warn('[AudioPlayer] Switching to fallback stream URL', { fallbackUrl, reason });
                setUsingFallback(true);
                setSourceUrl(fallbackUrl);
                resumeAfterSourceChangeRef.current = wasPlayingRef.current || pendingPlayRef.current;
            } catch (fallbackError) {
                console.error('[AudioPlayer] Failed to create fallback stream URL:', fallbackError);
            }
        };

        const handleError = async () => {
            const decodedError = decodeMediaError(audio.error);
            logEvent('error', decodedError);
            setError(decodedError);
            setErrorDetails({
                code: audio.error?.code ?? null,
                src: audio.currentSrc,
                readyState: audio.readyState,
                networkState: audio.networkState,
            });
            setIsPlaying(false);
            await attemptFallback('error', true);
        };
        const handleCanPlay = () => {
            logEvent('canplay');
            setError(null);
            setErrorDetails(null);
        };
        const handleCanPlayThrough = () => {
            logEvent('canplaythrough');
        };
        const handleStalled = () => {
            logEvent('stalled');
            attemptFallback('stalled', false).catch(() => undefined);
        };
        const handleWaiting = () => {
            logEvent('waiting');
            attemptFallback('waiting', false).catch(() => undefined);
        };

        audio.addEventListener('timeupdate', handleTimeUpdate);
        audio.addEventListener('durationchange', handleDurationChange);
        audio.addEventListener('play', handlePlay);
        audio.addEventListener('pause', handlePause);
        audio.addEventListener('ended', handleEnded);
        audio.addEventListener('error', handleError);
        audio.addEventListener('canplay', handleCanPlay);
        audio.addEventListener('canplaythrough', handleCanPlayThrough);
        audio.addEventListener('stalled', handleStalled);
        audio.addEventListener('waiting', handleWaiting);

        return () => {
            audio.removeEventListener('timeupdate', handleTimeUpdate);
            audio.removeEventListener('durationchange', handleDurationChange);
            audio.removeEventListener('play', handlePlay);
            audio.removeEventListener('pause', handlePause);
            audio.removeEventListener('ended', handleEnded);
            audio.removeEventListener('error', handleError);
            audio.removeEventListener('canplay', handleCanPlay);
            audio.removeEventListener('canplaythrough', handleCanPlayThrough);
            audio.removeEventListener('stalled', handleStalled);
            audio.removeEventListener('waiting', handleWaiting);
        };
    }, [usingFallback]);

    // Update playback rate when changed
    useEffect(() => {
        if (audioRef.current) {
            audioRef.current.playbackRate = playbackRate;
        }
    }, [playbackRate]);

    const togglePlayPause = () => {
        const audio = audioRef.current;
        if (!audio) return;

        if (!audio.paused) {
            pendingPlayRef.current = false;
            audio.pause();
        } else {
            pendingPlayRef.current = true;
            audio.play().catch(err => {
                console.error('[AudioPlayer] Play failed:', err);
                setError('Playback request failed.');
                setErrorDetails({
                    code: audio.error?.code ?? null,
                    src: audio.currentSrc,
                    readyState: audio.readyState,
                    networkState: audio.networkState,
                });
            });
        }
    };

    const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
        const audio = audioRef.current;
        if (!audio) return;

        const newTime = parseFloat(e.target.value);
        audio.currentTime = newTime;
        setCurrentTime(newTime);
    };

    const handleSpeedChange = () => {
        const currentIndex = PLAYBACK_SPEEDS.indexOf(playbackRate);
        const nextIndex = (currentIndex + 1) % PLAYBACK_SPEEDS.length;
        setPlaybackRate(PLAYBACK_SPEEDS[nextIndex]);
    };

    const formatTime = (seconds: number): string => {
        if (!isFinite(seconds)) return '0:00';
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    };

    return (
        <div className="audio-player">
            <audio ref={audioRef} src={sourceUrl} preload="metadata" />

            <div className="audio-player-row">
                <button
                    className={`audio-play-button ${isPlaying ? 'playing' : ''}`}
                    onClick={togglePlayPause}
                    disabled={!!error}
                    title={isPlaying ? 'Pause' : 'Play'}
                >
                    {isPlaying ? '⏸️' : '▶️'}
                </button>

                <div className="audio-controls">
                    <input
                        type="range"
                        className="audio-seek"
                        min={0}
                        max={duration || 100}
                        value={currentTime}
                        onChange={handleSeek}
                        disabled={!duration}
                    />

                    <div className="audio-time">
                        <span>{formatTime(currentTime)}</span>
                        <span className="audio-time-divider">/</span>
                        <span>{formatTime(duration)}</span>
                    </div>
                </div>

                <button
                    className="audio-speed-button"
                    onClick={handleSpeedChange}
                    title="Playback speed"
                >
                    {playbackRate}x
                </button>

                {error && (
                    <span className="audio-error" title={error}>⚠️</span>
                )}
            </div>

            {error && (
                <div className="audio-error-panel">
                    <div className="audio-error-title">Audio playback issue</div>
                    <div className="audio-error-message">{error}</div>
                    {errorDetails && (
                        <div className="audio-error-message">
                            Code: {errorDetails.code ?? 'unknown'} · Ready: {errorDetails.readyState} · Network: {errorDetails.networkState}
                        </div>
                    )}
                    {errorDetails?.src && (
                        <div className="audio-error-message">
                            Source: {errorDetails.src}
                        </div>
                    )}
                    {usingFallback && (
                        <div className="audio-error-message">Retrying with local stream.</div>
                    )}
                </div>
            )}
        </div>
    );
}

export default AudioPlayer;
