import catalogData from './spotify.json';
import type { CollectionCard, Playlist, Track } from '../types/library';

type SongMetadata = {
  id: string;
  title: string;
  author: string;
  coverPath: string;
  thumbnailUrl: string;
  durationSeconds: number | null;
  audioPath: string;
  videoPath: string;
  lyricsPath: string;
  artistBio?: string;
  showVideo?: boolean;
  top: boolean;
  madeForYou: boolean;
  recentlyAdded: boolean;
  nowPlaying?: boolean;
};

type PlaylistMetadata = {
  id: string;
  title: string;
  description: string;
  coverPath: string;
  songIds: string[];
};

type SpotifyCatalog = {
  songs: SongMetadata[];
  playlists: PlaylistMetadata[];
};

const catalog = catalogData as SpotifyCatalog;
const fallbackCover = '/wait-a-minute/image.png';

const toPublicPath = (path: string) => path ? `/${path.replace(/^songs\//, '')}` : '';
const formatDuration = (seconds: number | null) => {
  if (seconds === null) return '—';
  return `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;
};

export const tracks: Track[] = catalog.songs.map((song) => ({
  id: song.id,
  title: song.title,
  artist: song.author,
  cover: toPublicPath(song.coverPath) || song.thumbnailUrl || fallbackCover,
  duration: formatDuration(song.durationSeconds),
  accent: '#1ed760',
  audioSrc: toPublicPath(song.audioPath),
  videoSrc: song.showVideo === false ? '' : toPublicPath(song.videoPath),
  lyricsSrc: toPublicPath(song.lyricsPath),
  artistBio: song.artistBio || `${song.author} is credited as the artist on this local track.`,
}));

const trackById = new Map(tracks.map((track) => [track.id, track]));

const createSection = (flag: keyof Pick<SongMetadata, 'top' | 'madeForYou' | 'recentlyAdded'>): CollectionCard[] =>
  catalog.songs
    .filter((song) => song[flag])
    .map((song) => {
      const track = trackById.get(song.id)!;
      return {
        id: `${flag}-${song.id}`,
        title: track.title,
        artist: track.artist,
        description: track.artist,
        cover: track.cover,
        duration: track.duration,
        accent: track.accent,
        trackId: track.id,
      };
    });

export const topTracks = createSection('top');
export const madeForYou = createSection('madeForYou');
export const recentlyAdded = createSection('recentlyAdded');
export const nowPlaying = tracks.find((track) => catalog.songs.find((song) => song.id === track.id)?.nowPlaying) ?? tracks[0];

export const playlists: Playlist[] = catalog.playlists.map((playlist) => {
  const playlistTracks = playlist.songIds.map((id) => trackById.get(id)).filter((track): track is Track => Boolean(track));
  const firstTrack = playlistTracks[0] ?? nowPlaying;
  return {
    id: playlist.id,
    title: playlist.title,
    description: playlist.description,
    cover: toPublicPath(playlist.coverPath) || firstTrack.cover,
    accent: '#1ed760',
    tracks: playlistTracks,
  };
});
