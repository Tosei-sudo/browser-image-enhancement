<!DOCTYPE qgis PUBLIC 'http://mrcc.com/qgis.dtd' 'SYSTEM'>
<qgis version="3.34.4-Prizren" styleCategories="Symbology">
  <pipe>
    <provider><resampling enabled="false"/></provider>
    <rasterrenderer type="singlebandpseudocolor" band="1" opacity="1" alphaBand="-1" classificationMin="0" classificationMax="2000" nodataColor="">
      <rastershader>
        <colorrampshader minimumValue="0" maximumValue="2000" colorRampType="INTERPOLATED" classificationMode="1" clip="0">
          <item value="0" label="0" color="#2b83ba" alpha="255"/>
          <item value="500" label="500" color="#abdda4" alpha="255"/>
          <item value="1000" label="1000" color="#ffffbf" alpha="255"/>
          <item value="2000" label="2000" color="#d7191c" alpha="128"/>
        </colorrampshader>
      </rastershader>
    </rasterrenderer>
  </pipe>
</qgis>
