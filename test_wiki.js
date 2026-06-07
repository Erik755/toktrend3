const axios = require('axios');

async function testWikimedia(query) {
  const url = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(query)}&gsrnamespace=6&prop=imageinfo&iiprop=url&format=json&gsrlimit=5`;
  const res = await axios.get(url);
  const pages = res.data.query?.pages;
  if (!pages) return console.log('No results for', query);
  for (const p of Object.values(pages)) {
    console.log(p.imageinfo[0].url);
  }
}

testWikimedia('galaxy formation');
