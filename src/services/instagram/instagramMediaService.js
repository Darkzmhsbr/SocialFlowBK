// NOT IMPLEMENTED YET - placeholder for Phase 2+ (photo/reel/carousel publishing).
//
// The official Instagram Content Publishing flow is container-based, not
// browser automation: you create a media container pointing at a hosted
// image/video URL, poll its status, then publish it. These function names
// mirror that model so the eventual implementation slots in without
// reshaping the service layer or the controller/route above it.
//
// Reference: Meta's Content Publishing API docs (Instagram Platform).

async function createMediaContainer(/* { accountId, mediaUrl, caption, mediaType } */) {
  throw new Error('createMediaContainer is not implemented yet (planned for Phase 2).');
}

async function checkContainerStatus(/* containerId */) {
  throw new Error('checkContainerStatus is not implemented yet (planned for Phase 2).');
}

module.exports = { createMediaContainer, checkContainerStatus };
