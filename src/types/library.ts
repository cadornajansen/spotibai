export type Track = {
  id: string;
  title: string;
  artist: string;
  cover: string;
  duration: string;
  accent: string;
  audioSrc: string;
  videoSrc: string;
  lyricsSrc: string;
  artistBio: string;
};

export type CollectionCard = {
  id: string;
  title: string;
  description?: string;
  artist?: string;
  cover: string;
  accent: string;
  trackId: string;
  duration?: string;
};

export type Playlist = {
  id: string;
  title: string;
  description: string;
  cover: string;
  accent: string;
  tracks: Track[];
};

export type Library = {
  featuredPlaylists: CollectionCard[];
  recentlyPlayed: CollectionCard[];
  madeForYou: CollectionCard[];
  tracks: Track[];
  nowPlaying: Track;
};
