const Promise = require('bluebird');
const winapi = require('winapi-bindings');
const { fs, log, util } = require('vortex-api');
const path = require('path');
const MOD_FILE_EXT = ".vpk";
const STEAM_ID = 3545060;
const GAME_ID = 'teamfortress2classified';
const CUSTOM_FOLDER = path.join('tf2classified', 'custom');
const GAMEINFO_FILE = path.join('tf2classified', 'gameinfo.txt');

const INFO_FILE = path.join('tf2classified', 'steam.inf');
const CUSTOM_VPK_LINE = /^\s*"game\+mod\+custom_mod"\s*"\|gameinfo_path\|custom\/[^"]+\.vpk"\s*$/i;
const CUSTOM_WILDCARD_LINE = /^\s*"game\+mod\+custom_mod"\s*"\|gameinfo_path\|custom\/\*"\s*$/i;

function findGame() {
  return util.steam.findByAppId(STEAM_ID.toString())
    .then(game => game.gamePath);
}

let tools = [
  {
    id: 'hammerplusplus',
    name: 'Hammer++',
    logo: 'hammerplusplus.png',
    executable: () => 'hammerplusplus.exe',
    requiredFiles: [
      'hammerplusplus.exe',
    ],
  },
];
function installContent(files) {

  const modFile = files.find(file => path.extname(file).toLowerCase() === MOD_FILE_EXT);
  const idx = modFile.indexOf(path.basename(modFile));
  const rootPath = path.dirname(modFile);
  
 
  const filtered = files.filter(file => 
    ((file.indexOf(rootPath) !== -1) 
    && (!file.endsWith(path.sep))));

  const instructions = filtered.map(file => {
    return {
      type: 'copy',
      source: file,
      destination: path.join(file.substr(idx)),
    };
  });

  return Promise.resolve({ instructions });
}

function normalizeVpkName(fileName) {
  return fileName.replace(/\\/g, '/');
}

function getCustomVpkEntries(gamePath) {
  const customPath = path.join(gamePath, CUSTOM_FOLDER);
  return fs.readdirAsync(customPath)
    .then(files => files.filter(file => path.extname(file).toLowerCase() === MOD_FILE_EXT))
    .catch(() => []);
}

function parseGameInfoLoadOrder(contents) {
  return contents
    .split(/\r?\n/)
    .filter(line => CUSTOM_VPK_LINE.test(line))
    .map(line => {
      const match = line.match(/\|gameinfo_path\|custom\/([^"]+\.vpk)"/i);
      return match?.[1];
    })
    .filter(Boolean);
}

function updateGameInfoLoadOrder(contents, orderedVpks) {
  const lines = contents.split(/\r?\n/);
  const filteredLines = lines.filter(line => !CUSTOM_VPK_LINE.test(line));
  const wildcardIndex = filteredLines.findIndex(line => CUSTOM_WILDCARD_LINE.test(line));
  const insertIndex = wildcardIndex >= 0 ? wildcardIndex : filteredLines.length;
  const indentMatch = wildcardIndex >= 0 ? filteredLines[wildcardIndex].match(/^(\s*)/) : null;
  const indent = indentMatch?.[1] ?? '\t\t';
  const newLines = orderedVpks.map(vpk => (
    `${indent}"game+mod+custom_mod"\t"|gameinfo_path|custom/${normalizeVpkName(vpk)}"`
  ));
  filteredLines.splice(insertIndex, 0, ...newLines);
  return filteredLines.join('\n');
}

function serializeLoadOrder(loadOrder) {
  return findGame()
    .then(gamePath => {
      const ordered = loadOrder.filter(entry => entry.enabled)
        .map(entry => entry.id);
      const gameInfoPath = path.join(gamePath, GAMEINFO_FILE);
      return fs.readFileAsync(gameInfoPath, { encoding: 'utf8' })
        .then(contents => updateGameInfoLoadOrder(contents, ordered))
        .then(updated => fs.writeFileAsync(gameInfoPath, updated, { encoding: 'utf8' }));
    });
}

function deserializeLoadOrder() {
  return findGame()
    .then(gamePath => {
      const gameInfoPath = path.join(gamePath, GAMEINFO_FILE);
      return fs.readFileAsync(gameInfoPath, { encoding: 'utf8' })
        .then(contents => {
          const orderedFromFile = parseGameInfoLoadOrder(contents);
          return getCustomVpkEntries(gamePath)
            .then(currentVpks => {
              const remaining = currentVpks.filter(file => !orderedFromFile.includes(file));
              const combined = [...orderedFromFile, ...remaining];
              return combined.map(file => ({
                id: file,
                name: file,
                enabled: true,
              }));
            });
        });
    });
}

function validateLoadOrder(prev, current) {
  const invalid = current
    .filter(entry => path.extname(entry.id).toLowerCase() !== MOD_FILE_EXT)
    .map(entry => ({
      id: entry.id,
      reason: 'Load order entries must reference .vpk archives.',
    }));
  return Promise.resolve({ invalid });
}
function testSupportedContent(files, gameId) {
 
  let supported = (gameId === GAME_ID ) &&
    (files.find(file => path.extname(file).toLowerCase() === MOD_FILE_EXT) !== undefined);

  if (supported && files.find(file =>
      (path.basename(file).toLowerCase() === 'moduleconfig.xml')
      && (path.basename(path.dirname(file)).toLowerCase() === 'fomod'))) {
    supported = false;
  }
  return Promise.resolve({
    supported,
    requiredFiles: [],
  });
}

function getGameVersion(discoveryPath) {
  return fs.readFileAsync(path.join(discoveryPath, INFO_FILE), { encoding: 'utf8' })
    .then((data) => {
      const match = data.match(/^ClientVersion=[0-9]*$/gm);
      return (match?.[0] !== undefined)
        ? Promise.resolve(match[0].replace('ClientVersion=', ''))
        : Promise.reject(new util.DataInvalid('Failed to retrieve version'));
    })
}

function main(context) {
  context.registerGame({
    id: GAME_ID,
    name: 'Team Fortress 2 Classified',
    shortName: 'TF2C',
    mergeMods: true,
    queryPath: findGame,
    supportedTools: tools,
    queryModPath: () => CUSTOM_FOLDER,
    getGameVersion,
    logo: 'gameart.jpg',
    executable: () => 'tf2classified_win64.exe',
    requiredFiles: [
      'tf2classified_win64.exe',
      GAMEINFO_FILE,
    ],
    environment: {
      SteamAPPId: STEAM_ID.toString(),
    },
    details: {
      steamAppId: STEAM_ID,
      nexusPageId: GAME_ID,
    }
  });

  context.registerLoadOrder({
    gameId: GAME_ID,
    usageInstructions: 'Arrange the .vpk archives in the order they should be loaded. Entries are written into gameinfo.txt as custom search paths above the custom/* wildcard entry.',
    serializeLoadOrder: (loadOrder) => serializeLoadOrder(loadOrder),
    deserializeLoadOrder: () => deserializeLoadOrder(),
    validate: (prev, current) => validateLoadOrder(prev, current),
  });
  
  context.registerInstaller('teamfortress2classified-mod', 25, testSupportedContent, installContent);
  
  return true;
}

module.exports = {
  default: main,
};
