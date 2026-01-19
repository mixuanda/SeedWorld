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
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [playbackRate, setPlaybackRate] = useState(1.0);
    const [error, setError] = useState<string | null>(null);

    // Get secure URL for the audio file
    const audioUrl = window.api.attachment.getUrl(audioPath);

    useEffect(() => {
        const audio = audioRef.current;
        if (!audio) return;

        const handleTimeUpdate = () => setCurrentTime(audio.currentTime);
        const handleDurationChange = () => setDuration(audio.duration);
        const handlePlay = () => setIsPlaying(true);
        const handlePause = () => setIsPlaying(false);
        const handleEnded = () => setIsPlaying(false);
        const handleError = () => {
            setError('Failed to load audio');
            setIsPlaying(false);
        };
        const handleCanPlay = () => setError(null);

        audio.addEventListener('timeupdate', handleTimeUpdate);
        audio.addEventListener('durationchange', handleDurationChange);
        audio.addEventListener('play', handlePlay);
        audio.addEventListener('pause', handlePause);
        audio.addEventListener('ended', handleEnded);
        audio.addEventListener('error', handleError);
        audio.addEventListener('canplay', handleCanPlay);

        return () => {
            audio.removeEventListener('timeupdate', handleTimeUpdate);
            audio.removeEventListener('durationchange', handleDurationChange);
            audio.removeEventListener('play', handlePlay);
            audio.removeEventListener('pause', handlePause);
            audio.removeEventListener('ended', handleEnded);
            audio.removeEventListener('error', handleError);
            audio.removeEventListener('canplay', handleCanPlay);
        };
    }, []);

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
            audio.pause();
        } else {
            audio.play().catch(err => {
                console.error('[AudioPlayer] Play failed:', err);
                setError('Failed to play audio');
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
            <audio ref={audioRef} src={audioUrl} preload="metadata" />

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
    );
}

export default AudioPlayer;
