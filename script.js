const logsDiv = document.getElementById('logs');
const contentDiv = document.getElementById('content');

contentDiv.classList.add('loader');
contentDiv.classList.add('not-ready');

electronApi.onUpdate((e, val) => {
    const newDiv = document.createElement('p');
    const newString = `${val.newStatus}: ${val.description}`;
    newDiv.innerHTML = newString;
    logsDiv.appendChild(newDiv);
});

electronApi.onReady(() => {
    contentDiv.classList.remove('loader');
    contentDiv.classList.remove('not-ready');
    contentDiv.classList.add('ready');
    const newDiv = document.createElement('div');
    newDiv.innerHTML = 'Navigate to homegames.link using any device on your network';

    contentDiv.appendChild(newDiv);
});
