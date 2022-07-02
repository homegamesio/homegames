Live. Laugh. Love.

## GENERAL ##

This executable contains the Homegames web server as well as the Homegames core server. 

Running the executable will run these servers on your machine, allowing you to access the Homegames dashboard by navigating to `localhost` in a web browser.

If `LINK_ENABLED` is `true` in your config file, every other device on your local network will be able to access the Homegames dashboard and play games together by navigating to homegames.link in any web browser.



## WINDOWS ##

Double click the .exe file to run the Homegames app on your Windows device.

Windows Defender will likely block the application since its publisher cannot be verified. 

If this happens, click "more info" in the warning box and then click "run anyway".

We're going to fix this at some point in the future, but in the meantime if you're not willing to run the app in this state, 
we encourage you to build the app from the source code available at https://github.com/homegamesio/homegames



## MAC ##

Double click the `homegames-macos` binary to run the Homegames app on your Mac.

MacOS will likely block the application since its publisher cannot be verified.

If this happens, click OK and then navigate to System Preferences -> Security & Privacy -> General. There should be a message that says "homegames-macos was blocked from use because it is not from an identified developer." Click "Open Anyway" which should be to the right of that message.

We're going to fix this at some point in the future, but in the meantime if you're not willing to run the app in this state, 
we encourage you to build the app from the source code available at https://github.com/homegamesio/homegames



## LINUX ##

Run ./homegames-linux from the downloaded homegames directory.

The app server runs on port 80 (standard HTTP port) so you will likely need to run with `sudo`

