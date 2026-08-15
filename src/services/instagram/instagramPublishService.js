// NOT IMPLEMENTED YET - placeholder for Phase 2+ (photo), Phase 3 (Reels),
// Phase 4 (carousel), Phase 5 (Stories, subject to current API support).
//
// Each publish* function is expected to call instagramMediaService to
// create + poll a container, then hit the /media_publish endpoint via
// integrations/instagram/instagramApiClient. No browser automation, ever.

async function publishMedia(/* { accountId, containerId } */) {
  throw new Error('publishMedia is not implemented yet (planned for Phase 2).');
}

async function publishReel(/* { accountId, containerId } */) {
  throw new Error('publishReel is not implemented yet (planned for Phase 3).');
}

async function publishCarousel(/* { accountId, containerIds } */) {
  throw new Error('publishCarousel is not implemented yet (planned for Phase 4).');
}

async function publishStory(/* { accountId, containerId } */) {
  throw new Error('publishStory is not implemented yet (planned for Phase 5).');
}

module.exports = { publishMedia, publishReel, publishCarousel, publishStory };
